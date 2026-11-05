import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache


def _local_env_file():
    """`.env` is read only for local development.

    In the container every setting comes from environment variables; pydantic-settings
    gives environment variables precedence over the file in both cases. The file is
    looked up next to the backend directory (`schrijfassistent/backend/.env`) and, for a
    checkout, at the repository root. Set
    `SCHRIJFASSISTENT_ENV_FILE=` (empty) to disable the lookup, or point it at a file.
    """
    override = os.environ.get("SCHRIJFASSISTENT_ENV_FILE")
    if override is not None:
        return override or None
    if os.environ.get("SCHRIJFASSISTENT_IN_CONTAINER") == "1":
        return None
    here = Path(__file__).resolve()
    for candidate in (here.parents[2] / ".env", here.parents[4] / ".env"):
        if candidate.is_file():
            return str(candidate)
    return None


class Settings(BaseSettings):
    PROJECT_NAME: str = "Schrijfassistent API"
    API_V1_STR: str = "/api/v1"

    # Azure Storage configuration
    AZURE_STORAGE_CONNECTION_STRING: str = ""
    AZURE_STORAGE_CONTAINER_NAME: str = "govchat-docs"

    # --- AI provider (app/services/ai_agent.py) ------------------------------------------------
    # "foundry" (default): the Azure AI Foundry project at PROJECT_ENDPOINT, via DefaultAzureCredential.
    # "litellm": an OpenAI-compatible LiteLLM proxy at LITELLM_URL with LITELLM_API_KEY.
    AI_PROVIDER: str = "foundry"
    # Model to call: the deployment name in Foundry (empty = "chat-agent"), the model name in LiteLLM (required).
    AI_MODEL: str = ""

    # Azure AI Project Settings (AI_PROVIDER=foundry)
    PROJECT_ENDPOINT: str = ""

    # LiteLLM proxy (AI_PROVIDER=litellm), e.g. http://aca-flair-litellm-dev-schrwzr/v1 inside the Container Apps environment
    LITELLM_URL: str = ""
    LITELLM_API_KEY: str = ""

    # Deployment flags
    SCM_DO_BUILD_DURING_DEPLOYMENT: str = "false"

    # --- Auth and identity ---------------------------------------------------------------
    # Open WebUI origin the verifier forwards tokens to (the internal URL inside the
    # Container Apps environment). Required: the service refuses to start without it.
    OPENWEBUI_INTERNAL_URL: str = ""
    OPENWEBUI_VERIFY_TIMEOUT_SEC: float = 3.0
    # Comma-separated CORS allow-list. The default holds the two local development origins;
    # dev and prod set the GovChat origin.
    CORS_ALLOW_ORIGINS: str = "http://localhost:3000,http://localhost:5174"
    # Variant A fallback when the Front Door rule cannot strip the prefix:
    # ROOT_PATH=/apps/schrijfassistent. Empty keeps the routes at /api/v1/... unchanged.
    ROOT_PATH: str = ""
    # Request body limits in bytes (app/core/body_limit.py); a larger body answers 413.
    MAX_BODY_BYTES_UPLOAD_CONFIGURATION: int = 12 * 1024 * 1024
    MAX_BODY_BYTES_NOTA: int = 10 * 1024 * 1024
    MAX_BODY_BYTES_DEFAULT: int = 2 * 1024 * 1024

    model_config = SettingsConfigDict(
        env_file=_local_env_file(),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    def cors_allow_origins(self) -> list:
        return [o.strip() for o in self.CORS_ALLOW_ORIGINS.split(",") if o.strip()]


@lru_cache()
def get_settings():
    return Settings()


settings = get_settings()
