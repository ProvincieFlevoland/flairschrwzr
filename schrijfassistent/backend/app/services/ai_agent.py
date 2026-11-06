"""The one place where the backend calls a language model.

Two providers, chosen with `AI_PROVIDER`:

  * `foundry` (default): the Azure AI Foundry project at `PROJECT_ENDPOINT`, signed in with
    `DefaultAzureCredential` (the managed identity in Azure, `az login` locally).
  * `litellm`: an OpenAI-compatible LiteLLM proxy at `LITELLM_URL`, authenticated with `LITELLM_API_KEY`
    (a LiteLLM virtual key). No Azure sign-in is needed.

Both give an OpenAI client; the routes only use `client` (truthy when a provider is ready) and
`get_agent_response()`. The model comes from `AI_MODEL`: the deployment name in Foundry, the model name in
LiteLLM. LiteLLM needs it set; Foundry falls back to the deployment `chat-agent` so an existing setup keeps
working. The SDKs are imported only for the provider in use.

With LiteLLM a beheerder can choose another model per configuration, kop and opdracht (app/core/model_resolver.py):
`get_agent_response(prompt, model=...)` then calls that model. `available_models()` gives the models the LiteLLM key
may use (`/v1/models`, kept for a few minutes); the configurator shows them as its choice list. When LiteLLM refuses a
chosen model (unknown, or not allowed for the key) the call is retried once with `AI_MODEL`, so a schrijver is not
blocked by a configuration that points at a model that was removed.
"""
import logging
import threading
import time
from typing import List, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)

PROVIDERS = ("foundry", "litellm")
FOUNDRY_DEFAULT_MODEL = "chat-agent"

# How long the model list of LiteLLM is kept, and how long a failed lookup is not retried.
MODEL_LIST_TTL_SEC = 300.0
MODEL_LIST_RETRY_SEC = 60.0


def _is_model_refusal(error: Exception) -> bool:
    """True when the AI service refused the model itself (unknown model, or not allowed for this key).

    LiteLLM answers 400 "Invalid model name ...", 401/403 "key not allowed to access model ..." or 404; all of them
    name the model. Other failures (timeouts, 5xx, content filters) are not a reason to switch models."""
    status = getattr(error, "status_code", None)
    return status in (400, 401, 403, 404) and "model" in str(error).lower()


class AIAgentService:
    """Holds the OpenAI client of the configured provider; `client` is None when it is not configured."""

    def __init__(self):
        self.provider = (settings.AI_PROVIDER or "foundry").strip().lower()
        self.model = (settings.AI_MODEL or "").strip()
        self.endpoint = settings.PROJECT_ENDPOINT
        self.project_client = None
        self.client = None
        self._models_lock = threading.Lock()
        self._models: Optional[List[str]] = None
        self._models_at = 0.0
        self._models_failed_at = 0.0

        if self.provider == "litellm":
            self._init_litellm()
        elif self.provider == "foundry":
            self.model = self.model or FOUNDRY_DEFAULT_MODEL
            self._init_foundry()
        else:
            logger.error(
                "AI_PROVIDER=%r is not supported (use one of: %s); the AI routes are disabled.",
                self.provider, ", ".join(PROVIDERS),
            )

    def _init_foundry(self):
        if not self.endpoint:
            logger.warning("PROJECT_ENDPOINT is not set; the AI routes are disabled.")
            return
        try:
            from azure.ai.projects import AIProjectClient
            from azure.identity import DefaultAzureCredential

            # Connect to the AI Foundry Project (Azure AI Projects 2.x)
            self.project_client = AIProjectClient(endpoint=self.endpoint, credential=DefaultAzureCredential())
            self.client = self.project_client.get_openai_client()
            logger.info("AI provider foundry initialized (model %s).", self.model)
        except Exception as e:
            logger.error(f"Failed to initialize AI Project Client: {str(e)}")
            self.project_client = None
            self.client = None

    def _init_litellm(self):
        base_url = (settings.LITELLM_URL or "").strip().rstrip("/")
        if not base_url:
            logger.warning("AI_PROVIDER=litellm but LITELLM_URL is not set; the AI routes are disabled.")
            return
        if not self.model:
            logger.warning("AI_PROVIDER=litellm but AI_MODEL is not set; the AI routes are disabled.")
            return
        api_key = (settings.LITELLM_API_KEY or "").strip()
        if not api_key:
            # A LiteLLM proxy without a master key accepts any key; the OpenAI client refuses an empty one.
            logger.warning("LITELLM_API_KEY is not set; requests to LiteLLM are sent without a valid key.")
            api_key = "no-key"
        try:
            from openai import OpenAI

            self.client = OpenAI(base_url=base_url, api_key=api_key)
            logger.info("AI provider litellm initialized (model %s).", self.model)
        except Exception as e:
            logger.error(f"Failed to initialize LiteLLM client: {str(e)}")
            self.client = None

    def _not_initialized_hint(self) -> str:
        if self.provider == "litellm":
            return "Check LITELLM_URL, LITELLM_API_KEY and AI_MODEL."
        if self.provider == "foundry":
            return "Check your PROJECT_ENDPOINT and ensure you are logged in (e.g. az login)."
        return f"Set AI_PROVIDER to one of: {', '.join(PROVIDERS)}."

    @property
    def selectable(self) -> bool:
        """True when a beheerder can choose a model per configuration (only through LiteLLM)."""
        return self.provider == "litellm" and self.client is not None

    def list_models(self, force: bool = False) -> List[str]:
        """The model names the AI service offers to this backend, sorted. Raises when the service cannot be asked.

        LiteLLM: `GET /v1/models` with the backend's key, so the list holds only the models that key may use. Foundry
        has no such list: only the configured deployment. The answer is kept for MODEL_LIST_TTL_SEC."""
        if not self.selectable:
            return [self.model] if self.client and self.model else []
        now = time.monotonic()
        with self._models_lock:
            if not force and self._models is not None and now - self._models_at < MODEL_LIST_TTL_SEC:
                return list(self._models)
        page = self.client.models.list()
        names = sorted({m.id for m in getattr(page, "data", page) if getattr(m, "id", None)})
        with self._models_lock:
            self._models, self._models_at = names, time.monotonic()
        return list(names)

    def available_models(self) -> Optional[List[str]]:
        """The model list for checking a chosen model before a call, or None when it is not known.

        Never raises and never waits on a failing service again within MODEL_LIST_RETRY_SEC: an AI call must not
        fail because the list could not be fetched; the call itself then shows whether the model exists."""
        if not self.selectable:
            return None
        with self._models_lock:
            if self._models is not None and time.monotonic() - self._models_at < MODEL_LIST_TTL_SEC:
                return list(self._models)
            if time.monotonic() - self._models_failed_at < MODEL_LIST_RETRY_SEC:
                return list(self._models) if self._models is not None else None
        try:
            return self.list_models(force=True)
        except Exception as e:
            logger.warning("Could not fetch the model list of %s: %s", self.provider, type(e).__name__)
            with self._models_lock:
                self._models_failed_at = time.monotonic()
                return list(self._models) if self._models is not None else None

    def get_agent_response(self, user_message: str, model: Optional[str] = None) -> str:
        """
        Sends a single user message to the model and returns the reply text.

        `model` is the beheerder's choice (app/core/model_resolver.py); None or empty uses AI_MODEL. A chosen model
        that the AI service refuses is retried once with AI_MODEL.

        Raises:
            Exception: If the client is not initialised or the API call fails.
        """
        if not self.client:
            raise Exception(f"AI Client is not initialized (AI_PROVIDER={self.provider}). {self._not_initialized_hint()}")

        chosen = (model or "").strip() or self.model
        try:
            return self._complete(chosen, user_message)
        except Exception as e:
            if chosen != self.model and _is_model_refusal(e):
                logger.warning(
                    "Model %s was refused by %s (%s); retrying with the default model %s.",
                    chosen, self.provider, type(e).__name__, self.model,
                )
                try:
                    return self._complete(self.model, user_message)
                except Exception as e2:
                    logger.error(f"Error interacting with AI Inference API: {str(e2)}")
                    raise
            logger.error(f"Error interacting with AI Inference API: {str(e)}")
            raise

    def _complete(self, model: str, user_message: str) -> str:
        logger.info("Sending message to model %s via %s...", model, self.provider)
        response = self.client.chat.completions.create(
            model=model,
            messages=[
                {"role": "user", "content": user_message}
            ]
        )
        return response.choices[0].message.content

ai_agent = AIAgentService()
