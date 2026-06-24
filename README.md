# Upstox Live Option Chain Tracker

A python utility to stream and log real-time options chain data (including Greeks and Market Data) directly into an Excel sheet. 

Featuring a **zero-lock active-streaming mechanism**, the script detects if you have the spreadsheet open in Excel and writes updates in real-time via COM interface (`xlwings`), ensuring you never get file-lock or permission errors while trading. When the sheet is closed, it falls back to high-speed direct saving via `openpyxl`.

---

## Features

- **Live Option Chain Fetching**: Connects to the Upstox API v2 to pull real-time options data.
- **Dynamic Writing Engine**:
  - **Excel Closed**: Uses `openpyxl` to write data rapidly directly to the file system.
  - **Excel Open**: Detects open instances and uses `xlwings` (COM wrapper) to append live rows to the active worksheet without disrupting your view or requiring you to close the file.
- **Rich Formatting & Color Coding**:
  - **ATM (At-The-Money)** rows highlighted in yellow.
  - **ITM (In-The-Money)** calls/puts highlighted in soft green/red.
  - **OTM (Out-of-The-Money)** formatted using alternating zebra rows.
  - Custom number formatting for volumes, decimals, percentages, and currencies.
- **Comprehensive Options Sheets**:
  - **`Calls` Sheet**: Logs Call Greeks (Delta, Gamma, Theta, Vega, IV, PoP %) along with Volume, OI, OI Change, Bid/Ask, and LTP.
  - **`Puts` Sheet**: Logs matching Put metrics.
  - **`Greeks Guide`**: An in-workbook reference sheet defining each Greek, typical ranges, and color codes for easy understanding.
- **Smart Expiry Selection**: Automatically detects and picks the nearest upcoming contract expiry if a specific date isn't set.
- **ATM Strike Focus**: Customizable setting (`STRIKES_AROUND_ATM`) to extract only the active trading ranges (e.g., 20 strikes around ATM) rather than the entire chain.

---

## Project Structure

```text
upstox-price-steaming/
│
├── upstox_option_chain.py   # Main options chain fetcher & Excel logging script
├── requirements.txt         # Package dependencies
├── .env.example             # Example environment configuration file
└── README.md                # Project documentation
```

---

## Installation & Setup

### 1. Install Dependencies

Ensure you have Python 3.8+ installed. Install the required libraries using `pip`:

```bash
pip install -r requirements.txt
```

*Note: `xlwings` requires Microsoft Excel to be installed on Windows for the active COM streaming mode to function.*

### 2. Configure Your Upstox Access Token

You must provide a valid Upstox Access Token. 

1. Duplicate `.env.example` to create a new file named `.env`:
   ```bash
   copy .env.example .env
   ```
2. Open the `.env` file and insert your token:
   ```env
   UPSTOX_ACCESS_TOKEN=your_upstox_access_token_here
   ```

---

## Usage

Run the script from the root directory:

```bash
python upstox_option_chain.py
```

### Configuration Options

You can customize the script's behavior by modifying the settings directly inside [upstox_option_chain.py](file:///d:/Harsh/Community/upstox-price-steaming/upstox_option_chain.py) under the `USER CONFIGURATION` section (lines 35-56):

| Configuration Variable | Description | Default |
| :--- | :--- | :--- |
| `ACCESS_TOKEN` | Upstox API token. Reads from environment variable `UPSTOX_ACCESS_TOKEN` by default. | `os.getenv("UPSTOX_ACCESS_TOKEN")` |
| `UNDERLYING` | The instrument symbol to track (e.g., `NSE_INDEX\|Nifty 50`, `NSE_INDEX\|Nifty Bank`). | `"NSE_INDEX\|Nifty 50"` |
| `EXPIRY_DATE` | Filter for a specific expiry format `YYYY-MM-DD`. If `None`, it auto-picks the nearest upcoming expiry. | `None` |
| `REFRESH_INTERVAL` | Seconds to wait between fetches. | `5` |
| `STRIKES_AROUND_ATM` | The number of strike prices to capture above and below the ATM strike. Set to `None` for all strikes. | `20` |
| `OUTPUT_FILE` | Absolute path where the output spreadsheet is saved. | `option_chain_live.xlsx` |

---

## Excel Output Design

The generated `option_chain_live.xlsx` contains three sheets:

1. **Calls**: Contains fetch timestamp, spot price, expiry, strike, PCR, and comprehensive calls market data + Greeks.
2. **Puts**: Contains fetch timestamp, spot price, expiry, strike, PCR, and comprehensive puts market data + Greeks.
3. **Greeks Guide**: Quick reference definitions for Greeks (Delta, Gamma, Theta, Vega, IV, PoP%, PCR) and sheet color indicators.

### Formatting Highlights
- **Yellow Rows**: Strike closest to the Spot price (At-The-Money).
- **Green Cells (Calls Sheet)**: In-The-Money Call options.
- **Red Cells (Puts Sheet)**: In-The-Money Put options.
- **Blue Panels**: Core metadata headers.
