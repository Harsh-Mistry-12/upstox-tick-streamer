"""
Upstox REST API wrapper — adapted from upstox_option_chain_merged.py
"""
import datetime
import email.utils
import logging
import requests

log = logging.getLogger(__name__)

BASE_URL = "https://api.upstox.com/v2"

_access_token: str = ""


def set_token(token: str):
    global _access_token
    _access_token = token


def get_token() -> str:
    return _access_token


def _headers():
    return {
        "Authorization": f"Bearer {_access_token}",
        "Accept": "application/json",
    }


# ---------------------------------------------------------------------------
# API calls
# ---------------------------------------------------------------------------

def fetch_expiries(instrument_key: str) -> list[str]:
    url = f"{BASE_URL}/option/contract"
    r = requests.get(
        url,
        headers=_headers(),
        params={"instrument_key": instrument_key},
        timeout=15,
    )
    if r.status_code == 401:
        raise PermissionError("401 Unauthorized — token expired or invalid.")
    r.raise_for_status()
    expiries = sorted(
        set(c["expiry"] for c in r.json().get("data", []) if c.get("expiry"))
    )
    log.info("Found %d expiry dates for %s", len(expiries), instrument_key)
    return expiries


def fetch_option_chain(instrument_key: str, expiry_date: str):
    """Returns (data_list, server_date_header_str)."""
    url = f"{BASE_URL}/option/chain"
    r = requests.get(
        url,
        headers=_headers(),
        params={"instrument_key": instrument_key, "expiry_date": expiry_date},
        timeout=15,
    )
    if r.status_code == 401:
        raise PermissionError("401 Unauthorized — token expired or invalid.")
    r.raise_for_status()
    body = r.json()
    if body.get("status") != "success":
        raise ValueError(f"API non-success: {body}")
    return body.get("data", []), r.headers.get("Date", "")


def fetch_india_vix_details() -> dict | None:
    """Fetch live India VIX details including last_price, change, and percentage_change."""
    url = f"{BASE_URL}/market-quote/quotes"
    for key in ("NSE_INDEX|India VIX", "NSE_INDEX|INDIA VIX"):
        try:
            r = requests.get(
                url,
                headers=_headers(),
                params={"instrument_key": key},
                timeout=10,
            )
            if r.status_code == 200:
                data = r.json().get("data", {})
                for item in data.values():
                    if isinstance(item, dict) and "last_price" in item and item["last_price"] is not None:
                        last_price = float(item["last_price"])
                        net_change = item.get("net_change")
                        ohlc_close = item.get("ohlc", {}).get("close")

                        change = float(net_change) if net_change is not None else 0.0

                        # Calculate previous close & percentage change
                        if net_change is not None:
                            prev_close = last_price - change
                        elif ohlc_close:
                            prev_close = float(ohlc_close)
                            change = last_price - prev_close
                        else:
                            prev_close = 0.0

                        p_change = (change / prev_close * 100.0) if prev_close != 0 else 0.0

                        return {
                            "last_price": round(last_price, 2),
                            "change": round(change, 2),
                            "p_change": round(p_change, 2),
                        }
        except Exception as e:
            log.warning("fetch_india_vix_details(%s) error: %s", key, e)

    # Fallback to LTP endpoint if quotes endpoint fails
    vix_ltp = fetch_india_vix()
    if vix_ltp is not None:
        return {"last_price": round(vix_ltp, 2), "change": 0.0, "p_change": 0.0}
    return None


def fetch_india_vix() -> float | None:
    """Fetch live India VIX LTP from Upstox API."""
    url = f"{BASE_URL}/market-quote/ltp"
    for key in ("NSE_INDEX|India VIX", "NSE_INDEX|INDIA VIX"):
        try:
            r = requests.get(
                url,
                headers=_headers(),
                params={"instrument_key": key},
                timeout=10,
            )
            if r.status_code == 200:
                data = r.json().get("data", {})
                for item in data.values():
                    if isinstance(item, dict) and "last_price" in item and item["last_price"] is not None:
                        return float(item["last_price"])
        except Exception as e:
            log.warning("fetch_india_vix(%s) error: %s", key, e)
    return None


# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------

def deep_get(obj, path: str):
    for part in path.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(part)
    return obj


def parse_server_date(date_str: str) -> datetime.datetime:
    if not date_str:
        return datetime.datetime.now()
    try:
        dt = email.utils.parsedate_to_datetime(date_str)
        return dt.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    except Exception:
        return datetime.datetime.now()


def enrich_row(row: dict) -> dict:
    row["_call_chg_oi"] = (
        (deep_get(row, "call_options.market_data.oi") or 0)
        - (deep_get(row, "call_options.market_data.prev_oi") or 0)
    )
    row["_put_chg_oi"] = (
        (deep_get(row, "put_options.market_data.oi") or 0)
        - (deep_get(row, "put_options.market_data.prev_oi") or 0)
    )
    return row


def get_spot_price(data: list) -> float | None:
    return data[0].get("underlying_spot_price") if data else None


def get_atm_strike(data: list, spot: float | None) -> float | None:
    if spot and data:
        strikes = [r["strike_price"] for r in data]
        return min(strikes, key=lambda s: abs(s - spot))
    return None


def filter_strikes(data: list, spot: float | None, n: int | None) -> list:
    if n is None or spot is None or not data:
        return data
    strikes = [r["strike_price"] for r in data]
    atm = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
    return data[max(0, atm - n): min(len(data) - 1, atm + n) + 1]


# ---------------------------------------------------------------------------
# Available underlyings
# ---------------------------------------------------------------------------

UNDERLYINGS = {
    "Nifty 50": "NSE_INDEX|Nifty 50",
    "Nifty Bank": "NSE_INDEX|Nifty Bank",
    "Nifty Fin Service": "NSE_INDEX|Nifty Fin Service",
    "Nifty Midcap Select": "NSE_INDEX|NIFTY MID SELECT",
    "Sensex": "BSE_INDEX|SENSEX",
}
