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
"""
import logging

from app.core.config import settings

logger = logging.getLogger(__name__)

PROVIDERS = ("foundry", "litellm")
FOUNDRY_DEFAULT_MODEL = "chat-agent"


class AIAgentService:
    """Holds the OpenAI client of the configured provider; `client` is None when it is not configured."""

    def __init__(self):
        self.provider = (settings.AI_PROVIDER or "foundry").strip().lower()
        self.model = (settings.AI_MODEL or "").strip()
        self.endpoint = settings.PROJECT_ENDPOINT
        self.project_client = None
        self.client = None

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

    def get_agent_response(self, user_message: str) -> str:
        """
        Sends a single user message to the configured model and returns the reply text.

        Raises:
            Exception: If the client is not initialised or the API call fails.
        """
        if not self.client:
            raise Exception(f"AI Client is not initialized (AI_PROVIDER={self.provider}). {self._not_initialized_hint()}")

        try:
            logger.info("Sending message to model %s via %s...", self.model, self.provider)
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "user", "content": user_message}
                ]
            )
            return response.choices[0].message.content

        except Exception as e:
            logger.error(f"Error interacting with AI Inference API: {str(e)}")
            raise


ai_agent = AIAgentService()
