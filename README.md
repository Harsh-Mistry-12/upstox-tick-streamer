# ⚡ UpstoxPro — Live Option Chain Dashboard

A real-time **Upstox option chain** web application that streams live data via WebSocket, stores snapshots to MySQL, and provides a professional trading dashboard with Greeks, Formula Builder, and historical analysis.

---

## 📸 Features

| Feature | Description |
|---|---|
| 📊 **Live Option Chain** | Real-time call & put data for all expiries, refreshed every 5 seconds |
| 📈 **Greeks Tracker** | Delta, Gamma, Theta, Vega, IV, PoP — with historical charts per strike |
| 🧮 **Formula Builder** | Write custom expressions (e.g. `call_ltp - put_ltp`) as extra columns |
| 📂 **History Viewer** | Browse all stored snapshots with date/time range filtering |
| ⚙️ **Settings** | Switch underlying index, adjust strikes around ATM, refresh interval |
| 📚 **Greeks Guide** | Quick reference for all option Greeks with color-coded table |
| 🌐 **LAN Access** | Access the dashboard from any PC on the same network |

---

## 🗂️ Project Structure

```
upstox-price-steaming/
│
├── web_app/                        # Flask web application (main app)
│   ├── app.py                      # Flask + SocketIO server, background fetch loop
│   ├── db.py                       # MySQL database layer (connection pool, schema, queries)
│   ├── upstox_api.py               # Upstox REST API wrapper
│   ├── formula_engine.py           # Safe formula expression evaluator
│   ├── requirements.txt            # Python dependencies for the web app
│   ├── start_server.bat            # ▶ One-click startup script (activates .venv + starts server)
│   ├── templates/
│   │   └── index.html              # Single-page application (all pages in one HTML)
│   └── static/
│       ├── app.js                  # Frontend JavaScript (WebSocket, rendering, navigation)
│       ├── style.css               # Full UI stylesheet
│       ├── socket.io.min.js        # Socket.IO client (served locally, no internet needed)
│       └── chart.umd.min.js        # Chart.js (served locally, no internet needed)
│
├── .venv/                          # Python virtual environment
├── .env                            # Environment variables (not committed)
├── upstox_option_chain.py          # Standalone Excel-based option chain script
├── upstox_option_chain_merged.py   # Extended standalone version
└── README.md                       # This file
```

---

## ⚙️ Prerequisites

| Requirement | Version |
|---|---|
| Python | 3.11+ |
| MySQL Server | 8.0+ |
| Upstox Developer Account | [developer.upstox.com](https://developer.upstox.com) |

---

## 🚀 First-Time Setup

### 1. Clone / Download the project

```bash
git clone <repo-url>
cd upstox-price-steaming
```

### 2. Create the virtual environment

```bash
python -m venv .venv
```

### 3. Install dependencies

```bash
.venv\Scripts\activate
pip install -r web_app\requirements.txt
```

### 4. Set up MySQL

Make sure MySQL is running on `localhost:3306`. The app will **auto-create** the database and all tables on first run using these credentials:

| Setting | Value |
|---|---|
| Host | `localhost` |
| Port | `3306` |
| User | `root` |
| Password | `Logieagle@123` |
| Database | `upstox_option_chain` (auto-created) |

> To change credentials, edit the constants at the top of `web_app/db.py`.

### 5. Get Upstox API credentials

1. Go to [developer.upstox.com](https://developer.upstox.com) and create an app
2. Note your **Client ID** and **Client Secret**
3. Set the **Redirect URI** to `https://www.google.com/` (or any valid URI you control)

---

## ▶️ Running the Application

Simply double-click:

```
web_app\start_server.bat
```

This will:
1. Activate the `.venv` automatically
2. Start the Flask server on `http://localhost:5000`

> **From another PC on the same network**, find your server IP (`ipconfig`) and open `http://<YOUR-IP>:5000` in the browser.

---

## 🔑 Authentication (First Run)

The app uses Upstox OAuth2. On first run:

1. Open `http://localhost:5000` in your browser
2. Go to **Settings** → enter your **Client ID**, **Client Secret**, and **Redirect URI** → Save
3. Click **"Login with Upstox"** — you will be redirected to Upstox login
4. After login, you will be redirected to your redirect URI. **Copy the `code=` value from the URL**
5. Paste it into the app's auth dialog and submit
6. Streaming starts automatically ✅

> **Tip:** The access token is saved in MySQL and reused on every restart. You only need to re-authenticate when the token expires (typically daily).

**Alternative — Manual Token:**
If you already have an access token, use **Settings → Paste Access Token** to skip the OAuth flow entirely.

---

## 📊 Dashboard Pages

### Live Chain
- Real-time option chain table for the selected expiry
- Color coded: 🟢 ITM Calls · 🔴 ITM Puts · 🟡 ATM row
- Columns: Strike, LTP, OI, Change OI, Volume, IV, Delta, Gamma, Theta, Vega, PoP, PCR
- Toggle Greeks columns and % change display on/off

### Greeks
- Select any expiry + strike to plot historical Greeks as line charts
- Powered by Chart.js with data pulled from MySQL snapshots

### Formula Builder
- Write math expressions using option chain variables as extra table columns
- Available variables: `call_ltp`, `put_ltp`, `call_oi`, `put_oi`, `call_iv`, `put_iv`, `call_delta`, `put_delta`, `call_gamma`, `put_gamma`, `call_theta`, `put_theta`, `call_vega`, `put_vega`, `call_pop`, `put_pop`, `spot_price`, `strike_price`, `pcr`
- Saved formulas appear as extra columns in the Live Chain table

### History
- Browse stored snapshots with optional date/time range filter
- Snapshots are saved every 5 seconds to MySQL

### Settings
- Switch underlying index (Nifty 50, Bank Nifty, Fin Nifty, Midcap Select, Sensex)
- Adjust number of strikes displayed around ATM (5–50 each side)
- Change refresh interval (minimum 3 seconds)
- Manage API credentials and access token

---

## 🌐 LAN / Network Access

To allow other PCs on your local network to access the dashboard:

1. Find your server PC's IP address:
   ```
   ipconfig
   ```
   Look for `IPv4 Address` (e.g. `192.168.1.29`)

2. Open the firewall port — run as **Administrator**:
   ```
   netsh advfirewall firewall add rule name="UpstoxPro" dir=in action=allow protocol=TCP localport=5000
   ```

3. Other PCs open: `http://192.168.1.29:5000`

---

## 🗄️ Database Schema

Three tables are auto-created in the `upstox_option_chain` database:

| Table | Purpose |
|---|---|
| `option_chain_snapshots` | Time-series snapshots of all strikes (call/put OI, LTP, greeks, etc.) |
| `config` | Key-value store for app settings (token, client ID, underlying, etc.) |
| `formulas` | Saved user formulas (name, expression, color) |

---

## 🧩 Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python · Flask · Flask-SocketIO |
| Real-time | WebSocket (Socket.IO) |
| Database | MySQL 8 · mysql-connector-python |
| Frontend | Vanilla HTML / CSS / JavaScript |
| Charts | Chart.js 4 |
| API | Upstox v2 REST API |

---

## 🛠️ Troubleshooting

| Problem | Solution |
|---|---|
| `Could not activate .venv` | Run `python -m venv .venv` from the project root, then `pip install -r web_app\requirements.txt` |
| MySQL connection error | Verify MySQL is running and credentials in `web_app/db.py` match your setup |
| `401 Unauthorized` from Upstox | Token expired — re-authenticate via the Settings page |
| Other PC cannot connect | Add firewall rule for port 5000 (see LAN section above) |
| Only dashboard visible / pages not switching | Open browser DevTools (F12 → Console) for JS errors |
| WebSocket shows "Disconnected" | Check the Flask server is still running in the terminal |

---

## 📄 License

For personal and community use. Not affiliated with Upstox.
