"""
Upstox Option Chain — Flask + SocketIO Web Application

Streaming strategy:
  • Current expiry (index 0) + Next expiry (index 1) are fetched concurrently
    in the background every 5 s and pushed to all clients via WebSocket.
  • All other expiries are fetched on-demand (via /api/fetch_expiry) only when
    the user opens that expiry tab, and streaming stops when they switch away.
"""

import datetime
import json
import logging
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests as req_lib
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from flask_socketio import SocketIO, emit
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

import db
import formula_engine
import upstox_api

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(
            os.path.join(os.path.dirname(__file__), "web_app.log"),
            encoding="utf-8",
        ),
    ],
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config["SECRET_KEY"] = "upstox_ws_secret_2025"
CORS(app, origins="*")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")


def _strike_key(val) -> str:
    if val is None:
        return ""
    fval = float(val)
    return str(int(fval)) if fval % 1 == 0 else str(fval)

# ---------------------------------------------------------------------------
# Global application state
# ---------------------------------------------------------------------------

class AppState:
    def __init__(self):
        self.streaming: bool = False
        self.token_invalid: bool = False
        self.last_fetch_time: str | None = None
        self.last_error: str | None = None
        self.current_expiries: list[str] = []
        self.latest_data: dict = {}          # {underlying: {expiry: [chain_rows]}}
        self.latest_formula_results: dict = {} # {expiry: {strike: {fid: result}}}
        self.fetch_count: int = 0
        self.underlying: str = "NSE_INDEX|Nifty 50"
        self.strikes_around_atm: int = 20
        self.refresh_interval: int = 5       # seconds (streaming interval)
        self.db_save_interval: int = 300     # seconds (5 minutes DB storage interval)
        self.last_db_save_time: float = 0.0  # timestamp of last DB save
        self.db_save_count: int = 0         # count of 5-min DB saves
        self.india_vix: float | None = None  # live India VIX value
        self._lock = threading.Lock()


state = AppState()


# ---------------------------------------------------------------------------
# Background fetch thread
# ---------------------------------------------------------------------------

def _fetch_single_expiry(expiry: str) -> dict | None:
    """Fetch & process one expiry. Returns dict or None on failure."""
    try:
        fetch_time = datetime.datetime.now()
        data, server_date_str = upstox_api.fetch_option_chain(state.underlying, expiry)
        if not data:
            log.warning("Empty data for expiry %s.", expiry)
            return None

        spot = upstox_api.get_spot_price(data)
        data = upstox_api.filter_strikes(data, spot, state.strikes_around_atm)
        atm_strike = upstox_api.get_atm_strike(data, spot)

        # PCR for the whole expiry
        total_call_oi = sum(
            (upstox_api.deep_get(r, "call_options.market_data.oi") or 0) for r in data
        )
        total_put_oi = sum(
            (upstox_api.deep_get(r, "put_options.market_data.oi") or 0) for r in data
        )
        pcr = round(total_put_oi / total_call_oi, 4) if total_call_oi > 0 else None

        record_time = upstox_api.parse_server_date(server_date_str)
        chain_data: list[dict] = []
        db_rows: list[dict] = []

        for raw in data:
            row = upstox_api.enrich_row(raw)
            strike = row.get("strike_price", 0)
            is_atm = atm_strike is not None and strike == atm_strike

            chain_row = {
                "strike_price": strike,
                "spot_price":   spot,
                "is_atm":       is_atm,
                "pcr":          pcr,
                "fetch_time":   fetch_time.strftime("%Y-%m-%d %H:%M:%S"),
                # Call
                "call_volume":  upstox_api.deep_get(row, "call_options.market_data.volume"),
                "call_oi":      upstox_api.deep_get(row, "call_options.market_data.oi"),
                "call_prev_oi": upstox_api.deep_get(row, "call_options.market_data.prev_oi"),
                "call_chg_oi":  row.get("_call_chg_oi"),
                "call_ltp":     upstox_api.deep_get(row, "call_options.market_data.ltp"),
                "call_iv":      upstox_api.deep_get(row, "call_options.option_greeks.iv"),
                "call_delta":   upstox_api.deep_get(row, "call_options.option_greeks.delta"),
                "call_gamma":   upstox_api.deep_get(row, "call_options.option_greeks.gamma"),
                "call_theta":   upstox_api.deep_get(row, "call_options.option_greeks.theta"),
                "call_vega":    upstox_api.deep_get(row, "call_options.option_greeks.vega"),
                "call_pop":     upstox_api.deep_get(row, "call_options.option_greeks.pop"),
                # Put
                "put_volume":   upstox_api.deep_get(row, "put_options.market_data.volume"),
                "put_oi":       upstox_api.deep_get(row, "put_options.market_data.oi"),
                "put_prev_oi":  upstox_api.deep_get(row, "put_options.market_data.prev_oi"),
                "put_chg_oi":   row.get("_put_chg_oi"),
                "put_ltp":      upstox_api.deep_get(row, "put_options.market_data.ltp"),
                "put_iv":       upstox_api.deep_get(row, "put_options.option_greeks.iv"),
                "put_delta":    upstox_api.deep_get(row, "put_options.option_greeks.delta"),
                "put_gamma":    upstox_api.deep_get(row, "put_options.option_greeks.gamma"),
                "put_theta":    upstox_api.deep_get(row, "put_options.option_greeks.theta"),
                "put_vega":     upstox_api.deep_get(row, "put_options.option_greeks.vega"),
                "put_pop":      upstox_api.deep_get(row, "put_options.option_greeks.pop"),
            }
            chain_data.append(chain_row)

            db_rows.append({
                "fetch_time":   fetch_time,
                "record_time":  record_time,
                "expiry":       expiry,
                "underlying":   state.underlying,
                "spot_price":   spot,
                "strike_price": strike,
                "call_volume":  chain_row["call_volume"],
                "call_oi":      chain_row["call_oi"],
                "call_prev_oi": chain_row["call_prev_oi"],
                "call_chg_oi":  chain_row["call_chg_oi"],
                "call_ltp":     chain_row["call_ltp"],
                "call_iv":      chain_row["call_iv"],
                "call_delta":   chain_row["call_delta"],
                "call_gamma":   chain_row["call_gamma"],
                "call_theta":   chain_row["call_theta"],
                "call_vega":    chain_row["call_vega"],
                "call_pop":     chain_row["call_pop"],
                "put_volume":   chain_row["put_volume"],
                "put_oi":       chain_row["put_oi"],
                "put_prev_oi":  chain_row["put_prev_oi"],
                "put_chg_oi":   chain_row["put_chg_oi"],
                "put_ltp":      chain_row["put_ltp"],
                "put_iv":       chain_row["put_iv"],
                "put_delta":    chain_row["put_delta"],
                "put_gamma":    chain_row["put_gamma"],
                "put_theta":    chain_row["put_theta"],
                "put_vega":     chain_row["put_vega"],
                "put_pop":      chain_row["put_pop"],
                "is_atm":       1 if is_atm else 0,
                "pcr":          pcr,
            })

        return {
            "expiry":     expiry,
            "spot":       spot,
            "pcr":        pcr,
            "chain_data": chain_data,
            "db_rows":    db_rows,
        }

    except PermissionError:
        log.warning("401 for expiry %s — token invalid.", expiry)
        with state._lock:
            state.token_invalid = True
        return None
    except Exception as exc:
        log.error("_fetch_single_expiry(%s): %s", expiry, exc)
        return None


def is_market_open(dt: datetime.datetime | None = None) -> bool:
    """
    Checks if Indian equity/options market is currently open.
    Regular trading hours: Monday - Friday, 09:15 to 15:30 IST.
    """
    if dt is None:
        dt = datetime.datetime.now()
    if dt.weekday() >= 5:  # Saturday or Sunday
        return False
    current_time = dt.time()
    market_start = datetime.time(9, 15)
    market_end = datetime.time(15, 30)
    return market_start <= current_time <= market_end


def _calculate_duration_tag(save_count: int) -> str:
    """
    Calculates duration tag based on 5-minute interval milestones.
    Base interval: 5m (for every 5-min snapshot stored in DB).
    Milestones:
      - 12 x 5m   = 1 hr   (1h)
      - 24 x 5m   = 2 hr   (2h)
      - 36 x 5m   = 3 hr   (3h)
      - 48 x 5m   = 4 hr   (4h)
      - 288 x 5m  = 1 day  (1d)
      - 2016 x 5m = 1 week (1w)
      - 8640 x 5m = 1 month (1month)
    """
    tags = ["5m"]
    if save_count > 0:
        if save_count % 12 == 0:
            tags.append("1h")
        if save_count % 24 == 0:
            tags.append("2h")
        if save_count % 36 == 0:
            tags.append("3h")
        if save_count % 48 == 0:
            tags.append("4h")
        if save_count % 288 == 0:
            tags.append("1d")
        if save_count % 2016 == 0:
            tags.append("1w")
        if save_count % 8640 == 0:
            tags.append("1month")
    return ", ".join(tags)


def background_fetch():
    """
    Runs forever in a daemon thread.
    Only fetches the CURRENT expiry (index 0) and NEXT expiry (index 1)
    concurrently every `state.refresh_interval` seconds.
    All other expiries are served on-demand via /api/fetch_expiry.
    Data is pushed live via WebSocket every tick, but persisted to DB every 5 minutes.
    """
    log.info("Background fetch thread started (current + next expiry only).")
    while True:
        if not state.streaming:
            time.sleep(1)
            continue

        token = db.get_config("access_token", "")
        if not token:
            with state._lock:
                state.token_invalid = True
            socketio.emit("status_update", {
                "streaming": False,
                "token_valid": False,
                "message": "No access token — please authenticate.",
            })
            time.sleep(5)
            continue

        upstox_api.set_token(token)

        try:
            all_expiries = upstox_api.fetch_expiries(state.underlying)
            today = datetime.date.today().isoformat()
            all_expiries = [e for e in all_expiries if e >= today]

            if not all_expiries:
                log.warning("No upcoming expiries.")
                time.sleep(state.refresh_interval)
                continue

            with state._lock:
                state.current_expiries = all_expiries

            # ── fetch only current + next expiry concurrently ─────────────
            priority_expiries = all_expiries[:2]          # [current, next]
            results: list[dict] = []
            workers = min(2, len(priority_expiries))
            with ThreadPoolExecutor(max_workers=workers) as exe:
                futures = {exe.submit(_fetch_single_expiry, exp): exp for exp in priority_expiries}
                for fut in as_completed(futures):
                    res = fut.result()
                    if res:
                        results.append(res)

            if not results:
                time.sleep(state.refresh_interval)
                continue

            results.sort(key=lambda r: r["expiry"])

            # ── save to MySQL (every 5 minutes / 300 seconds, ONLY during market hours) ────────────
            now = time.time()
            if is_market_open():
                if state.last_db_save_time == 0 or (now - state.last_db_save_time >= state.db_save_interval):
                    state.db_save_count += 1
                    duration_tag = _calculate_duration_tag(state.db_save_count)
                    all_db_rows: list[dict] = []
                    for r in results:
                        for row in r["db_rows"]:
                            row["duration"] = duration_tag
                            all_db_rows.append(row)
                    db.save_snapshots(all_db_rows)
                    state.last_db_save_time = now
                    log.info("Saved %d snapshot rows to DB (duration: '%s', save #%d).", len(all_db_rows), duration_tag, state.db_save_count)
            else:
                log.debug("Market is closed (outside 09:15-15:30 IST / weekend). Skipping DB snapshot save.")

            # ── update in-memory cache ────────────────────────────────────
            with state._lock:
                und = state.underlying
                if und not in state.latest_data:
                    state.latest_data[und] = {}
                for r in results:
                    state.latest_data[und][r["expiry"]] = r["chain_data"]
                state.last_fetch_time = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                state.fetch_count += 1
                state.token_invalid = False
                state.last_error = None

            # ── compute formula results ───────────────────────────────────
            formulas = db.get_formulas()
            formula_results: dict = {}
            if formulas:
                for r in results:
                    exp = r["expiry"]
                    formula_results[exp] = {}
                    for crow in r["chain_data"]:
                        strike_key = _strike_key(crow["strike_price"])
                        formula_results[exp][strike_key] = {}
                        vars_ = formula_engine.build_row_variables(crow)
                        for f in formulas:
                            val, err = formula_engine.evaluate(f["expression"], vars_)
                            formula_results[exp][strike_key][str(f["id"])] = {
                                "name":  f["name"],
                                "value": val,
                                "error": err,
                                "color": f.get("color", "#60a5fa"),
                            }

            # ── broadcast via WebSocket (current+next only) ───────────────
            # We emit the full expiry list so the frontend knows all tabs,
            # but only push data for the two priority expiries.
            socketio.emit("option_chain_update", {
                "underlying":        und,
                "expiries":          all_expiries,       # full list for tab rendering
                "priority_expiries": priority_expiries,  # only these have fresh data
                "data":              {r["expiry"]: r["chain_data"] for r in results},
                "formula_results":   formula_results,
                "fetch_time":        state.last_fetch_time,
                "fetch_count":       state.fetch_count,
            })
            socketio.emit("status_update", {
                "streaming":    True,
                "token_valid":  True,
                "fetch_time":   state.last_fetch_time,
                "fetch_count":  state.fetch_count,
                "expiry_count": len(all_expiries),
            })

        except PermissionError:
            with state._lock:
                state.token_invalid = True
            socketio.emit("status_update", {
                "streaming":   False,
                "token_valid": False,
                "message":     "Token expired — please re-authenticate.",
            })
        except Exception as exc:
            with state._lock:
                state.last_error = str(exc)
            log.error("Background fetch loop error: %s", exc)

        time.sleep(state.refresh_interval)


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    return jsonify({
        "streaming":    state.streaming,
        "token_valid":  not state.token_invalid,
        "last_fetch":   state.last_fetch_time,
        "fetch_count":  state.fetch_count,
        "expiries":     state.current_expiries,
        "underlying":   state.underlying,
        "last_error":   state.last_error,
        "refresh_interval": state.refresh_interval,
        "india_vix":    state.india_vix,
    })


@app.route("/api/vix")
def api_vix():
    """Separate endpoint to fetch live India VIX details directly."""
    token = db.get_config("access_token", "")
    if token:
        upstox_api.set_token(token)
    details = upstox_api.fetch_india_vix_details()
    if details:
        with state._lock:
            state.india_vix = details.get("last_price")
        return jsonify(details)
    return jsonify({"last_price": state.india_vix, "change": 0.0, "p_change": 0.0})


# ── Auth ──────────────────────────────────────────────────────────────────

@app.route("/api/auth/url")
def api_auth_url():
    client_id = db.get_config("client_id") or os.getenv("UPSTOX_CLIENT_ID", "")
    redirect_uri = db.get_config("redirect_uri") or os.getenv("UPSTOX_REDIRECT_URI", "https://www.google.com/")
    url = (
        "https://api.upstox.com/v2/login/authorization/dialog"
        f"?response_type=code&client_id={client_id}&redirect_uri={redirect_uri}"
    )
    return jsonify({"url": url, "redirect_uri": redirect_uri})


@app.route("/api/auth/token", methods=["POST"])
def api_auth_token():
    body = request.get_json(force=True) or {}
    code = body.get("code", "").strip()
    if not code:
        return jsonify({"error": "No code provided"}), 400

    client_id     = db.get_config("client_id") or os.getenv("UPSTOX_CLIENT_ID", "")
    client_secret = db.get_config("client_secret") or os.getenv("UPSTOX_CLIENT_SECRET", "")
    redirect_uri  = db.get_config("redirect_uri") or os.getenv("UPSTOX_REDIRECT_URI", "https://www.google.com/")

    try:
        r = req_lib.post(
            "https://api.upstox.com/v2/login/authorization/token",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "code":          code,
                "client_id":     client_id,
                "client_secret": client_secret,
                "redirect_uri":  redirect_uri,
                "grant_type":    "authorization_code",
            },
            timeout=15,
        )
        r.raise_for_status()
        token_data = r.json()
        token = token_data.get("access_token")
        if not token:
            return jsonify({"error": "No access_token in response", "detail": token_data}), 400

        db.set_config("access_token", token)
        upstox_api.set_token(token)
        with state._lock:
            state.token_invalid = False
            state.streaming = True
        log.info("New access token saved.")
        return jsonify({"success": True, "message": "Token saved. Streaming started."})
    except req_lib.HTTPError as e:
        return jsonify({"error": str(e), "detail": e.response.text if e.response else ""}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/auth/manual_token", methods=["POST"])
def api_manual_token():
    """Accept a raw access token pasted by the user."""
    body = request.get_json(force=True) or {}
    token = body.get("token", "").strip()
    if not token:
        return jsonify({"error": "No token provided"}), 400
    db.set_config("access_token", token)
    upstox_api.set_token(token)
    with state._lock:
        state.token_invalid = False
        state.streaming = True
    return jsonify({"success": True, "message": "Token saved. Streaming started."})


# ── Streaming control ─────────────────────────────────────────────────────

@app.route("/api/streaming/start", methods=["POST"])
def api_start():
    with state._lock:
        state.streaming = True
    return jsonify({"streaming": True})


@app.route("/api/streaming/stop", methods=["POST"])
def api_stop():
    with state._lock:
        state.streaming = False
    return jsonify({"streaming": False})


# ── Option chain data ──────────────────────────────────────────────────────

@app.route("/api/expiries")
def api_expiries():
    underlying = request.args.get("underlying", state.underlying)
    try:
        token = db.get_config("access_token", "")
        if token:
            upstox_api.set_token(token)
            expiries = upstox_api.fetch_expiries(underlying)
            today = datetime.date.today().isoformat()
            return jsonify({"expiries": [e for e in expiries if e >= today]})
    except Exception:
        pass
    return jsonify({"expiries": state.current_expiries})


@app.route("/api/fetch_expiry", methods=["POST"])
def api_fetch_expiry():
    """
    On-demand fetch for a single non-priority expiry.
    Called by the frontend when the user opens an expiry tab that is NOT
    the current or next expiry.  The result is emitted via WebSocket so
    the browser table updates automatically, and also returned in the
    HTTP response for convenience.
    Returns 204 with {"streaming": false} if global streaming is paused.
    """
    body = request.get_json(force=True) or {}
    expiry = body.get("expiry", "").strip()
    if not expiry:
        return jsonify({"error": "expiry required"}), 400

    if not state.streaming:
        return jsonify({"streaming": False, "message": "Streaming is paused."}), 200

    token = db.get_config("access_token", "")
    if not token:
        return jsonify({"error": "No access token"}), 401

    upstox_api.set_token(token)
    result = _fetch_single_expiry(expiry)
    if result is None:
        return jsonify({"error": f"Failed to fetch expiry {expiry}"}), 500

    # Persist to DB if market is open
    if is_market_open():
        for r in result["db_rows"]:
            r["duration"] = "5m"
        db.save_snapshots(result["db_rows"])
    else:
        log.info("Market is closed. Skipping on-demand DB snapshot save for %s.", expiry)

    # Update in-memory cache
    with state._lock:
        und = state.underlying
        if und not in state.latest_data:
            state.latest_data[und] = {}
        state.latest_data[und][expiry] = result["chain_data"]

    # Compute formula results for this expiry
    formulas = db.get_formulas()
    formula_results: dict = {expiry: {}}
    if formulas:
        for crow in result["chain_data"]:
            strike_key = _strike_key(crow["strike_price"])
            formula_results[expiry][strike_key] = {}
            vars_ = formula_engine.build_row_variables(crow)
            for f in formulas:
                val, err = formula_engine.evaluate(f["expression"], vars_)
                formula_results[expiry][strike_key][str(f["id"])] = {
                    "name":  f["name"],
                    "value": val,
                    "error": err,
                    "color": f.get("color", "#60a5fa"),
                }

    # Broadcast only this expiry's data so all connected clients update
    with state._lock:
        und = state.underlying
        all_expiries = state.current_expiries

    socketio.emit("on_demand_expiry_update", {
        "underlying":     und,
        "expiry":         expiry,
        "data":           {expiry: result["chain_data"]},
        "formula_results": formula_results,
        "fetch_time":     datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    })

    return jsonify({
        "success":  True,
        "expiry":   expiry,
        "rows":     len(result["chain_data"]),
    })


@app.route("/api/option_chain")
def api_option_chain():
    underlying = request.args.get("underlying", state.underlying)
    expiry = request.args.get("expiry", "")
    if not expiry:
        return jsonify({"error": "expiry required"}), 400
    rows = db.get_latest_snapshot(underlying, expiry)
    return jsonify({"data": rows, "expiry": expiry, "count": len(rows)})


@app.route("/api/history")
def api_history():
    underlying = request.args.get("underlying", state.underlying)
    expiry = request.args.get("expiry", "")
    from_dt = request.args.get("from")
    to_dt = request.args.get("to")
    duration = request.args.get("duration")
    raw_limit = request.args.get("snapshots_limit") or request.args.get("limit") or 20
    snapshots_limit = int(raw_limit)
    if not expiry:
        return jsonify({"error": "expiry required"}), 400
    rows = db.get_history(underlying, expiry, from_dt, to_dt, duration, snapshots_limit)
    unique_snapshots = len(set(r["fetch_time"] for r in rows)) if rows else 0
    return jsonify({
        "data": rows,
        "count": len(rows),
        "snapshots_count": unique_snapshots,
        "expiry": expiry
    })


@app.route("/api/greeks/history")
def api_greeks_history():
    underlying = request.args.get("underlying", state.underlying)
    expiry = request.args.get("expiry", "")
    strike = request.args.get("strike", "")
    limit = int(request.args.get("limit", 200))
    if not expiry or not strike:
        return jsonify({"error": "expiry and strike required"}), 400
    rows = db.get_greeks_history(underlying, expiry, strike, limit)
    return jsonify({"data": rows})


# ── Formulas ──────────────────────────────────────────────────────────────

@app.route("/api/formulas", methods=["GET"])
def api_get_formulas():
    return jsonify({"formulas": db.get_formulas()})


@app.route("/api/formulas", methods=["POST"])
def api_save_formula():
    body = request.get_json(force=True) or {}
    name  = body.get("name", "").strip()
    expr  = body.get("expression", "").strip()
    desc  = body.get("description", "")
    color = body.get("color", "#60a5fa")

    if not name or not expr:
        return jsonify({"error": "name and expression are required"}), 400

    valid, err = formula_engine.validate_formula(expr)
    if not valid:
        return jsonify({"error": f"Invalid formula: {err}"}), 400

    fid = body.get("id")
    if fid:
        db.update_formula(int(fid), name, expr, desc, color)
        update_formula_results_cache()
        _broadcast_cached_chain()
        return jsonify({"success": True, "id": int(fid)})
    else:
        new_id = db.save_formula(name, expr, desc, color)
        update_formula_results_cache()
        _broadcast_cached_chain()
        return jsonify({"success": True, "id": new_id})


@app.route("/api/formulas/<int:fid>", methods=["DELETE"])
def api_delete_formula(fid: int):
    db.delete_formula(fid)
    update_formula_results_cache()
    _broadcast_cached_chain()
    return jsonify({"success": True})


@app.route("/api/formulas/validate", methods=["POST"])
def api_validate_formula():
    body = request.get_json(force=True) or {}
    expr = body.get("expression", "").strip()
    valid, err = formula_engine.validate_formula(expr)
    return jsonify({"valid": valid, "error": err})


# ── Config ────────────────────────────────────────────────────────────────

@app.route("/api/config", methods=["GET"])
def api_get_config():
    return jsonify({
        "underlying":        state.underlying,
        "strikes_around_atm": state.strikes_around_atm,
        "refresh_interval":  state.refresh_interval,
        "client_id":         db.get_config("client_id") or os.getenv("UPSTOX_CLIENT_ID", ""),
        "redirect_uri":      db.get_config("redirect_uri") or os.getenv("UPSTOX_REDIRECT_URI", "https://www.google.com/"),
        "has_token":         bool(db.get_config("access_token", "")),
        "underlyings":       upstox_api.UNDERLYINGS,
    })


@app.route("/api/config", methods=["POST"])
def api_update_config():
    body = request.get_json(force=True) or {}

    if "underlying" in body:
        with state._lock:
            state.underlying = body["underlying"]
        db.set_config("underlying", body["underlying"])

    if "strikes_around_atm" in body:
        val = max(0, int(body["strikes_around_atm"]))
        with state._lock:
            state.strikes_around_atm = val
        db.set_config("strikes_around_atm", val)

    if "refresh_interval" in body:
        val = max(3, int(body["refresh_interval"]))
        with state._lock:
            state.refresh_interval = val
        db.set_config("refresh_interval", val)

    for key in ("client_id", "client_secret", "redirect_uri"):
        if key in body:
            db.set_config(key, body[key])

    if "access_token" in body:
        token = body["access_token"].strip()
        db.set_config("access_token", token)
        upstox_api.set_token(token)
        with state._lock:
            state.token_invalid = False

    return jsonify({"success": True})


# ── Formula evaluation caching & broadcasting ──────────────────────────────

def update_formula_results_cache():
    """Computes formula results for the current latest cached data."""
    formulas = db.get_formulas()
    formula_results = {}
    with state._lock:
        und = state.underlying
        if und in state.latest_data:
            for expiry, rows in state.latest_data[und].items():
                formula_results[expiry] = {}
                for crow in rows:
                    strike_key = _strike_key(crow["strike_price"])
                    formula_results[expiry][strike_key] = {}
                    vars_ = formula_engine.build_row_variables(crow)
                    for f in formulas:
                        val, err = formula_engine.evaluate(f["expression"], vars_)
                        formula_results[expiry][strike_key][str(f["id"])] = {
                            "name":  f["name"],
                            "value": val,
                            "error": err,
                            "color": f.get("color", "#60a5fa"),
                        }
        state.latest_formula_results = formula_results


def _broadcast_cached_chain():
    with state._lock:
        und = state.underlying
        if und in state.latest_data and state.latest_data[und]:
            all_expiries    = state.current_expiries
            priority_expiries = all_expiries[:2]
            # Only broadcast data for priority expiries to avoid sending stale
            # on-demand data over the "push" channel.
            priority_data = {
                exp: state.latest_data[und][exp]
                for exp in priority_expiries
                if exp in state.latest_data[und]
            }
            priority_formula = {
                exp: state.latest_formula_results.get(exp, {})
                for exp in priority_expiries
            }
            socketio.emit("option_chain_update", {
                "underlying":        und,
                "expiries":          all_expiries,
                "priority_expiries": priority_expiries,
                "data":              priority_data,
                "formula_results":   priority_formula,
                "fetch_time":        state.last_fetch_time,
                "fetch_count":       state.fetch_count,
            })


# ── WebSocket events ───────────────────────────────────────────────────────

@socketio.on("connect")
def on_connect():
    log.info("WS client connected: %s", request.sid)
    emit("status_update", {
        "streaming":   state.streaming,
        "token_valid": not state.token_invalid,
        "fetch_time":  state.last_fetch_time,
        "fetch_count": state.fetch_count,
    })
    with state._lock:
        und = state.underlying
        all_expiries      = state.current_expiries
        priority_expiries = all_expiries[:2]
        if und in state.latest_data and state.latest_data[und]:
            priority_data = {
                exp: state.latest_data[und][exp]
                for exp in priority_expiries
                if exp in state.latest_data[und]
            }
            priority_formula = {
                exp: state.latest_formula_results.get(exp, {})
                for exp in priority_expiries
            }
            emit("option_chain_update", {
                "underlying":        und,
                "expiries":          all_expiries,
                "priority_expiries": priority_expiries,
                "data":              priority_data,
                "formula_results":   priority_formula,
                "fetch_time":        state.last_fetch_time,
                "fetch_count":       state.fetch_count,
            })


@socketio.on("disconnect")
def on_disconnect():
    log.info("WS client disconnected: %s", request.sid)


@socketio.on("ping_server")
def on_ping(data):
    emit("pong_server", {"ts": datetime.datetime.now().isoformat()})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _bootstrap():
    """Called once before the server starts."""
    db.init_db()

    # Persist defaults
    for key, val in [
        ("client_id",     os.getenv("UPSTOX_CLIENT_ID", "")),
        ("client_secret", os.getenv("UPSTOX_CLIENT_SECRET", "")),
        ("redirect_uri",  os.getenv("UPSTOX_REDIRECT_URI", "https://www.google.com/")),
    ]:
        if not db.get_config(key) and val:
            db.set_config(key, val)

    # Restore saved configurations
    saved_underlying = db.get_config("underlying")
    if saved_underlying:
        state.underlying = saved_underlying

    saved_strikes = db.get_config("strikes_around_atm")
    if saved_strikes is not None:
        try:
            state.strikes_around_atm = int(saved_strikes)
        except ValueError:
            pass

    saved_interval = db.get_config("refresh_interval")
    if saved_interval is not None:
        try:
            state.refresh_interval = int(saved_interval)
        except ValueError:
            pass

    # Pre-load latest data from MySQL database history
    try:
        conn = db.get_conn()
        cur = conn.cursor()
        # Find distinct expiries in DB that are >= today
        today_str = datetime.date.today().isoformat()
        cur.execute("""
            SELECT DISTINCT expiry FROM option_chain_snapshots 
            WHERE underlying = %s AND expiry >= %s
        """, (state.underlying, today_str))
        expiries_db = [str(r[0]) for r in cur.fetchall()]
        cur.close()
        conn.close()

        if expiries_db:
            expiries_db.sort()
            with state._lock:
                state.current_expiries = expiries_db
                state.latest_data[state.underlying] = {}
                for exp in expiries_db:
                    rows = db.get_latest_snapshot(state.underlying, exp)
                    if rows:
                        state.latest_data[state.underlying][exp] = rows
                        state.last_fetch_time = rows[0]["fetch_time"]
                state.fetch_count = 1
            update_formula_results_cache()
            log.info("Pre-loaded %d expiries from database history.", len(expiries_db))
    except Exception as e:
        log.warning("Could not pre-load data from DB: %s", e)

    # Auto-start streaming if token exists
    token = db.get_config("access_token", "")
    if token:
        upstox_api.set_token(token)
        state.streaming = True
        log.info("Existing token found — streaming auto-started.")
    else:
        log.info("No token yet — visit http://localhost:5000 to authenticate.")

    # Start background thread
    t = threading.Thread(target=background_fetch, daemon=True, name="bg-fetch")
    t.start()


if __name__ == "__main__":
    _bootstrap()
    log.info("Starting server at http://localhost:5000")
    socketio.run(
        app,
        host="0.0.0.0",
        port=5000,
        debug=True,
        allow_unsafe_werkzeug=True,
    )
