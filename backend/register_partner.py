import httpx
import os

from app.auth.oauth import SCOPES

client_id = os.environ["TESLA_CLIENT_ID"]
client_secret = os.environ["TESLA_CLIENT_SECRET"]
domain = os.environ["DOMAIN"]

fleet_base = "https://fleet-api.prd.eu.vn.cloud.tesla.com"

print("Fetching partner token...")
r = httpx.post(
    "https://auth.tesla.com/oauth2/v3/token",
    data={
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
        # Kept in sync with app/auth/oauth.py — one scope list, not two.
        "scope": SCOPES,
        "audience": fleet_base,
    }
)
r.raise_for_status()
token = r.json()["access_token"]
print("Got partner token!")

print("Registering partner account...")
r = httpx.post(
    f"{fleet_base}/api/1/partner_accounts",
    headers={"Authorization": f"Bearer {token}"},
    json={"domain": domain}
)
if r.status_code != 200:
    print("Error:", r.text)
r.raise_for_status()
print("Success:", r.json())
