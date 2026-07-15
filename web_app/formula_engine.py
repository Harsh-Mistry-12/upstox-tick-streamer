"""
Safe AST-based formula evaluator for option chain data.

Available variables (per-row):
  strike, spot, pcr, is_atm
  call_volume, call_oi, call_prev_oi, call_chg_oi
  call_ltp, call_iv, call_delta, call_gamma, call_theta, call_vega, call_pop
  put_volume, put_oi, put_prev_oi, put_chg_oi
  put_ltp, put_iv, put_delta, put_gamma, put_theta, put_vega, put_pop

Available functions: abs(), round(), min(), max(), sqrt(), log()

Example expressions:
  call_ltp - put_ltp                      # Synthetic future offset
  call_iv - put_iv                        # IV skew
  call_oi / put_oi                        # PCR per strike
  (call_delta + put_delta) * 100          # Net delta %
  abs(call_theta) + abs(put_theta)        # Total theta decay
"""

import ast
import math
import operator
import logging

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Safe operator map
# ---------------------------------------------------------------------------

_BIN_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.FloorDiv: operator.floordiv,
}

_UNARY_OPS = {
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}

_CMP_OPS = {
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
}

_SAFE_FUNCS = {
    "abs": abs,
    "round": round,
    "min": min,
    "max": max,
    "sqrt": math.sqrt,
    "log": math.log,
    "log10": math.log10,
    "exp": math.exp,
    "floor": math.floor,
    "ceil": math.ceil,
}

# All variable names a formula may reference
ALL_VARIABLE_NAMES = {
    "strike", "spot", "pcr", "is_atm",
    "call_volume", "call_oi", "call_prev_oi", "call_chg_oi",
    "call_ltp", "call_iv", "call_delta", "call_gamma",
    "call_theta", "call_vega", "call_pop",
    "put_volume", "put_oi", "put_prev_oi", "put_chg_oi",
    "put_ltp", "put_iv", "put_delta", "put_gamma",
    "put_theta", "put_vega", "put_pop",
}


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------

def _eval_node(node, variables: dict):
    if isinstance(node, ast.Constant):
        if not isinstance(node.value, (int, float, bool)):
            raise ValueError(f"Unsupported constant type: {type(node.value)}")
        return float(node.value)

    if isinstance(node, ast.Name):
        name = node.id
        if name not in ALL_VARIABLE_NAMES:
            raise ValueError(f"Unknown variable: '{name}'")
        v = variables.get(name)
        return float(v) if v is not None else None

    if isinstance(node, ast.BinOp):
        op_cls = type(node.op)
        if op_cls not in _BIN_OPS:
            raise ValueError(f"Unsupported operator: {op_cls.__name__}")
        left = _eval_node(node.left, variables)
        right = _eval_node(node.right, variables)
        if left is None or right is None:
            return None
        return _BIN_OPS[op_cls](left, right)

    if isinstance(node, ast.UnaryOp):
        op_cls = type(node.op)
        if op_cls not in _UNARY_OPS:
            raise ValueError(f"Unsupported unary operator: {op_cls.__name__}")
        operand = _eval_node(node.operand, variables)
        if operand is None:
            return None
        return _UNARY_OPS[op_cls](operand)

    if isinstance(node, ast.Compare):
        left = _eval_node(node.left, variables)
        for cmp_op, comparator in zip(node.ops, node.comparators):
            op_cls = type(cmp_op)
            if op_cls not in _CMP_OPS:
                raise ValueError(f"Unsupported comparison: {op_cls.__name__}")
            right = _eval_node(comparator, variables)
            if left is None or right is None:
                return None
            if not _CMP_OPS[op_cls](left, right):
                return 0.0
            left = right
        return 1.0

    if isinstance(node, ast.IfExp):
        test = _eval_node(node.test, variables)
        if test is None:
            return None
        return _eval_node(node.body if test else node.orelse, variables)

    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name):
            raise ValueError("Unsupported call (only simple function names allowed).")
        fname = node.func.id
        if fname not in _SAFE_FUNCS:
            raise ValueError(f"Unknown function: '{fname}'")
        args = [_eval_node(arg, variables) for arg in node.args]
        if any(a is None for a in args):
            return None
        return float(_SAFE_FUNCS[fname](*args))

    raise ValueError(f"Unsupported node type: {type(node).__name__}")


def evaluate(expression: str, variables: dict) -> tuple:
    """
    Evaluate formula for one row.
    Returns (result_float_or_None, error_str_or_None).
    """
    try:
        tree = ast.parse(expression.strip(), mode="eval")
        result = _eval_node(tree.body, variables)
        if result is None:
            return None, None
        return round(float(result), 6), None
    except ZeroDivisionError:
        return None, "Division by zero"
    except ValueError as e:
        return None, str(e)
    except SyntaxError as e:
        return None, f"Syntax error: {e.msg}"
    except Exception as e:
        return None, str(e)


def validate_formula(expression: str) -> tuple[bool, str | None]:
    """Return (True, None) or (False, error_message)."""
    dummy = {k: 100.0 for k in ALL_VARIABLE_NAMES}
    dummy["put_oi"] = 1.0   # avoid division by zero in PCR-style formulas
    dummy["call_oi"] = 1.0

    try:
        ast.parse(expression.strip(), mode="eval")
    except SyntaxError as e:
        return False, f"Syntax error: {e.msg}"

    _, err = evaluate(expression, dummy)
    if err and err != "Division by zero":
        return False, err
    return True, None


def build_row_variables(row: dict) -> dict:
    """Convert a snapshot dict into the variables dict used by evaluate()."""
    def sf(v):
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    return {
        "strike":       sf(row.get("strike_price")),
        "spot":         sf(row.get("spot_price")),
        "pcr":          sf(row.get("pcr")),
        "is_atm":       1.0 if row.get("is_atm") else 0.0,
        "call_volume":  sf(row.get("call_volume")),
        "call_oi":      sf(row.get("call_oi")),
        "call_prev_oi": sf(row.get("call_prev_oi")),
        "call_chg_oi":  sf(row.get("call_chg_oi")),
        "call_ltp":     sf(row.get("call_ltp")),
        "call_iv":      sf(row.get("call_iv")),
        "call_delta":   sf(row.get("call_delta")),
        "call_gamma":   sf(row.get("call_gamma")),
        "call_theta":   sf(row.get("call_theta")),
        "call_vega":    sf(row.get("call_vega")),
        "call_pop":     sf(row.get("call_pop")),
        "put_volume":   sf(row.get("put_volume")),
        "put_oi":       sf(row.get("put_oi")),
        "put_prev_oi":  sf(row.get("put_prev_oi")),
        "put_chg_oi":   sf(row.get("put_chg_oi")),
        "put_ltp":      sf(row.get("put_ltp")),
        "put_iv":       sf(row.get("put_iv")),
        "put_delta":    sf(row.get("put_delta")),
        "put_gamma":    sf(row.get("put_gamma")),
        "put_theta":    sf(row.get("put_theta")),
        "put_vega":     sf(row.get("put_vega")),
        "put_pop":      sf(row.get("put_pop")),
    }
