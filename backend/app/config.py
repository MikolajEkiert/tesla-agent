"""Central configuration, read from environment variables (.env in dev)."""
from __future__ import annotations

import os
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()


class Settings:
    # LLM provider: "gemini" (default) or "anthropic"
    llm_provider: str = os.getenv("LLM_PROVIDER", "gemini").lower()

    # Google Gemini (default)
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")
    # gemini-3.5-flash-lite: free-tier daily quota is ~500 requests vs. only
    # 20/day on gemini-3.6-flash (Google throttles free access to its newest
    # models hardest). Plenty for a personal assistant; check your own exact
    # limit at https://aistudio.google.com/rate-limit if you ever hit it.
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")

    # Google Cloud Text-to-Speech — spoken replies. A different product from
    # the Gemini key above and a different project, so a separate variable:
    # they look interchangeable and are not.
    google_tts_api_key: str = os.getenv("GOOGLE_TTS_API_KEY", "")

    # Whether a spoken word may settle a confirmation card (never for unlock —
    # see actions.VOICE_CONFIRMABLE). A server-side off switch as well as the
    # in-app setting, so the capability can be withdrawn without shipping an
    # app build.
    voice_confirm_enabled: bool = os.getenv("AMP_VOICE_CONFIRM", "1").strip().lower() not in (
        "0",
        "false",
        "no",
    )

    # Anthropic (fallback provider)
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

    # Open Charge Map — curated charger database used for lookups Tesla's own
    # API can't answer (other networks, places away from the car). Free key
    # from https://openchargemap.org/site/develop/api. Without it the app
    # falls back to OpenStreetMap, which needs no key but is patchier.
    ocm_api_key: str = os.getenv("OCM_API_KEY", "")

    # App
    cors_origins: list[str] = [
        o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()
    ]


@lru_cache
def get_settings() -> Settings:
    return Settings()
