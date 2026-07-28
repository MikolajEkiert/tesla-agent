"""Central configuration, read from environment variables (.env in dev)."""
from __future__ import annotations

import os
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()


class Settings:
    # LLM
    anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")
    anthropic_model: str = os.getenv("ANTHROPIC_MODEL", "claude-opus-5")

    # Adapter
    tesla_adapter: str = os.getenv("TESLA_ADAPTER", "mock").lower()

    # Tesla Fleet API (only used by the fleet adapter)
    tesla_client_id: str = os.getenv("TESLA_CLIENT_ID", "")
    tesla_client_secret: str = os.getenv("TESLA_CLIENT_SECRET", "")
    tesla_app_domain: str = os.getenv("TESLA_APP_DOMAIN", "")
    tesla_redirect_uri: str = os.getenv("TESLA_REDIRECT_URI", "")
    tesla_proxy_url: str = os.getenv("TESLA_PROXY_URL", "https://tesla-proxy:4443")
    tesla_fleet_base: str = os.getenv(
        "TESLA_FLEET_BASE", "https://fleet-api.prd.eu.vn.cloud.tesla.com"
    )

    # App
    cors_origins: list[str] = [
        o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()
    ]


@lru_cache
def get_settings() -> Settings:
    return Settings()
