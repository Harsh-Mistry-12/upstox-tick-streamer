"""
MySQL database layer for Upstox Option Chain Web App.
"""
import logging
import os
from datetime import datetime, date
from dotenv import load_dotenv

import mysql.connector
from mysql.connector import pooling, Error

log = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

# ---------------------------------------------------------------------------
# Connection config
# ---------------------------------------------------------------------------

DB_HOST = os.getenv("DB_HOST", "localhost")
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_PORT = int(os.getenv("DB_PORT", 3306))
DB_NAME = os.getenv("DB_NAME", "upstox_option_chain")

_pool: pooling.MySQLConnectionPool | None = None


def _make_pool() -> pooling.MySQLConnectionPool:
    return pooling.MySQLConnectionPool(
        pool_name="upstox_pool",
        pool_size=15,
        pool_reset_session=True,
        host=DB_HOST,
        user=DB_USER,
        password=DB_PASSWORD,
        port=DB_PORT,
        database=DB_NAME,
        autocommit=True,
        charset="utf8mb4",
        collation="utf8mb4_unicode_ci",
    )


def get_conn():
    global _pool
    if _pool is None:
        _pool = _make_pool()
    return _pool.get_connection()


# ---------------------------------------------------------------------------
# Init DB & schema
# ---------------------------------------------------------------------------

def init_db():
    """Create database and all tables if they do not exist."""
    # Step 1: Create DB (no DB-specific pool needed)
    raw = mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        port=DB_PORT, autocommit=True, charset="utf8mb4",
    )
    cur = raw.cursor()
    cur.execute(
        f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
        "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    )
    cur.close()
    raw.close()

    # Step 2: Build connection pool now that DB exists
    global _pool
    _pool = _make_pool()

    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS config (
            `key`       VARCHAR(200)    PRIMARY KEY,
            `value`     TEXT,
            updated_at  TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
                                        ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS option_chain_snapshots (
            id            BIGINT          AUTO_INCREMENT PRIMARY KEY,
            fetch_time    DATETIME(0)     NOT NULL,
            record_time   DATETIME(0),
            expiry        DATE            NOT NULL,
            underlying    VARCHAR(100)    NOT NULL,
            spot_price    DECIMAL(12,4),
            strike_price  DECIMAL(12,4)   NOT NULL,
            -- CALL side
            call_volume   BIGINT,
            call_oi       BIGINT,
            call_prev_oi  BIGINT,
            call_chg_oi   BIGINT,
            call_ltp      DECIMAL(12,4),
            call_iv       DECIMAL(10,4),
            call_delta    DECIMAL(10,6),
            call_gamma    DECIMAL(14,8),
            call_theta    DECIMAL(10,4),
            call_vega     DECIMAL(10,6),
            call_pop      DECIMAL(10,4),
            -- PUT side
            put_volume    BIGINT,
            put_oi        BIGINT,
            put_prev_oi   BIGINT,
            put_chg_oi    BIGINT,
            put_ltp       DECIMAL(12,4),
            put_iv        DECIMAL(10,4),
            put_delta     DECIMAL(10,6),
            put_gamma     DECIMAL(14,8),
            put_theta     DECIMAL(10,4),
            put_vega      DECIMAL(10,6),
            put_pop       DECIMAL(10,4),
            -- meta
            is_atm        TINYINT(1)      DEFAULT 0,
            pcr           DECIMAL(10,4),
            created_at    TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_exp_fetch  (expiry, fetch_time),
            INDEX idx_underlying (underlying),
            INDEX idx_fetch_time (fetch_time),
            INDEX idx_strike     (strike_price)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS formulas (
            id           INT             AUTO_INCREMENT PRIMARY KEY,
            name         VARCHAR(100)    NOT NULL,
            expression   TEXT            NOT NULL,
            description  TEXT,
            color        VARCHAR(30)     DEFAULT '#60a5fa',
            created_at   TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
            updated_at   TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
                                         ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    cur.close()
    conn.close()
    log.info("Database '%s' initialised.", DB_NAME)


# ---------------------------------------------------------------------------
# Helper: serialise rows
# ---------------------------------------------------------------------------

import decimal

def _serialise(rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        r = {}
        for k, v in row.items():
            if isinstance(v, (datetime,)):
                r[k] = v.strftime("%Y-%m-%d %H:%M:%S")
            elif isinstance(v, date):
                r[k] = v.isoformat()
            elif isinstance(v, decimal.Decimal):
                r[k] = float(v)
            else:
                r[k] = v
        out.append(r)
    return out


# ---------------------------------------------------------------------------
# Config CRUD
# ---------------------------------------------------------------------------

def get_config(key: str, default=None):
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT `value` FROM config WHERE `key` = %s", (key,))
        row = cur.fetchone()
        cur.close(); conn.close()
        return row[0] if row else default
    except Error as e:
        log.error("get_config(%s) error: %s", key, e)
        return default


def set_config(key: str, value: str):
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO config (`key`, `value`) VALUES (%s, %s) "
            "ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
            (key, str(value)),
        )
        cur.close(); conn.close()
    except Error as e:
        log.error("set_config(%s) error: %s", key, e)


# ---------------------------------------------------------------------------
# Snapshot CRUD
# ---------------------------------------------------------------------------

_INSERT_SQL = """
    INSERT INTO option_chain_snapshots (
        fetch_time, record_time, expiry, underlying, spot_price, strike_price,
        call_volume, call_oi, call_prev_oi, call_chg_oi,
        call_ltp, call_iv, call_delta, call_gamma, call_theta, call_vega, call_pop,
        put_volume, put_oi, put_prev_oi, put_chg_oi,
        put_ltp, put_iv, put_delta, put_gamma, put_theta, put_vega, put_pop,
        is_atm, pcr
    ) VALUES (
        %(fetch_time)s, %(record_time)s, %(expiry)s, %(underlying)s,
        %(spot_price)s, %(strike_price)s,
        %(call_volume)s, %(call_oi)s, %(call_prev_oi)s, %(call_chg_oi)s,
        %(call_ltp)s, %(call_iv)s, %(call_delta)s, %(call_gamma)s,
        %(call_theta)s, %(call_vega)s, %(call_pop)s,
        %(put_volume)s, %(put_oi)s, %(put_prev_oi)s, %(put_chg_oi)s,
        %(put_ltp)s, %(put_iv)s, %(put_delta)s, %(put_gamma)s,
        %(put_theta)s, %(put_vega)s, %(put_pop)s,
        %(is_atm)s, %(pcr)s
    )
"""


def save_snapshots(rows: list[dict]):
    if not rows:
        return
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.executemany(_INSERT_SQL, rows)
        cur.close(); conn.close()
        log.debug("Saved %d snapshot rows.", len(rows))
    except Error as e:
        log.error("save_snapshots error: %s", e)


def get_latest_snapshot(underlying: str, expiry: str) -> list[dict]:
    try:
        conn = get_conn()
        cur = conn.cursor(dictionary=True)
        cur.execute("""
            SELECT * FROM option_chain_snapshots
            WHERE underlying = %s AND expiry = %s
              AND fetch_time = (
                  SELECT MAX(fetch_time) FROM option_chain_snapshots
                  WHERE underlying = %s AND expiry = %s
              )
            ORDER BY strike_price ASC
        """, (underlying, expiry, underlying, expiry))
        rows = cur.fetchall()
        cur.close(); conn.close()
        return _serialise(rows)
    except Error as e:
        log.error("get_latest_snapshot error: %s", e)
        return []


def get_history(
    underlying: str,
    expiry: str,
    from_dt=None,
    to_dt=None,
    limit: int = 2000,
) -> list[dict]:
    try:
        conn = get_conn()
        cur = conn.cursor(dictionary=True)
        params: list = [underlying, expiry]
        where = "WHERE underlying = %s AND expiry = %s"
        if from_dt:
            where += " AND fetch_time >= %s"
            params.append(from_dt)
        if to_dt:
            where += " AND fetch_time <= %s"
            params.append(to_dt)
        params.append(limit)
        cur.execute(
            f"SELECT * FROM option_chain_snapshots {where} "
            "ORDER BY fetch_time DESC, strike_price ASC LIMIT %s",
            params,
        )
        rows = cur.fetchall()
        cur.close(); conn.close()
        return _serialise(rows)
    except Error as e:
        log.error("get_history error: %s", e)
        return []


def get_greeks_history(
    underlying: str, expiry: str, strike, limit: int = 200
) -> list[dict]:
    try:
        conn = get_conn()
        cur = conn.cursor(dictionary=True)
        cur.execute("""
            SELECT fetch_time, spot_price,
                   call_delta, call_gamma, call_theta, call_vega, call_iv,
                   call_ltp, call_oi, call_chg_oi, call_pop,
                   put_delta,  put_gamma,  put_theta,  put_vega,  put_iv,
                   put_ltp,  put_oi,  put_chg_oi,  put_pop,
                   pcr
            FROM option_chain_snapshots
            WHERE underlying = %s AND expiry = %s AND strike_price = %s
            ORDER BY fetch_time DESC
            LIMIT %s
        """, (underlying, expiry, strike, limit))
        rows = cur.fetchall()
        cur.close(); conn.close()
        return list(reversed(_serialise(rows)))   # oldest-first for charts
    except Error as e:
        log.error("get_greeks_history error: %s", e)
        return []


def get_available_expiries_db(underlying: str) -> list[str]:
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT DISTINCT expiry FROM option_chain_snapshots "
            "WHERE underlying = %s ORDER BY expiry ASC",
            (underlying,),
        )
        rows = cur.fetchall()
        cur.close(); conn.close()
        return [str(r[0]) for r in rows]
    except Error as e:
        log.error("get_available_expiries_db error: %s", e)
        return []


def get_distinct_fetch_times(underlying: str, expiry: str, limit: int = 500) -> list[str]:
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT DISTINCT fetch_time FROM option_chain_snapshots "
            "WHERE underlying=%s AND expiry=%s ORDER BY fetch_time DESC LIMIT %s",
            (underlying, expiry, limit),
        )
        rows = cur.fetchall()
        cur.close(); conn.close()
        return [r[0].strftime("%Y-%m-%d %H:%M:%S") if hasattr(r[0], "strftime") else str(r[0]) for r in rows]
    except Error as e:
        log.error("get_distinct_fetch_times error: %s", e)
        return []


# ---------------------------------------------------------------------------
# Formula CRUD
# ---------------------------------------------------------------------------

def get_formulas() -> list[dict]:
    try:
        conn = get_conn()
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT * FROM formulas ORDER BY created_at ASC")
        rows = cur.fetchall()
        cur.close(); conn.close()
        return _serialise(rows)
    except Error as e:
        log.error("get_formulas error: %s", e)
        return []


def save_formula(name: str, expression: str, description: str = "", color: str = "#60a5fa") -> int | None:
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO formulas (name, expression, description, color) VALUES (%s,%s,%s,%s)",
            (name, expression, description, color),
        )
        fid = cur.lastrowid
        cur.close(); conn.close()
        return fid
    except Error as e:
        log.error("save_formula error: %s", e)
        return None


def update_formula(fid: int, name: str, expression: str, description: str = "", color: str = "#60a5fa"):
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            "UPDATE formulas SET name=%s, expression=%s, description=%s, color=%s WHERE id=%s",
            (name, expression, description, color, fid),
        )
        cur.close(); conn.close()
    except Error as e:
        log.error("update_formula error: %s", e)


def delete_formula(fid: int):
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM formulas WHERE id=%s", (fid,))
        cur.close(); conn.close()
    except Error as e:
        log.error("delete_formula error: %s", e)
