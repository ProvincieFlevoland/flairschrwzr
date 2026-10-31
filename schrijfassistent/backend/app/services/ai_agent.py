from azure.ai.projects import AIProjectClient
from azure.identity import DefaultAzureCredential
from app.core.config import settings
import logging

logger = logging.getLogger(__name__)


class AIAgentService:
    """Connects to Azure AI Projects / OpenAI inference for chat and structured completions."""

    def __init__(self):
        """Creates the project client and OpenAI client when `PROJECT_ENDPOINT` is set; otherwise `client` is None."""
        self.endpoint = settings.PROJECT_ENDPOINT
        
        if self.endpoint:
            try:
                # Connect to the AI Foundry Project (Azure AI Projects 2.x)
                self.project_client = AIProjectClient(
                    endpoint=self.endpoint,
                    credential=DefaultAzureCredential()
                )
                self.client = self.project_client.get_openai_client()
                logger.info("Azure AI Project Inference Client initialized successfully!")
            except Exception as e:
                logger.error(f"Failed to initialize AI Project Client: {str(e)}")
                self.project_client = None
                self.client = None
        else:
            self.client = None
            logger.warning("PROJECT_ENDPOINT is not set in .env")

    def get_agent_response(self, user_message: str) -> str:
        """
        Sends a single user message to the `chat-agent` deployment and returns the reply text.

        Raises:
            Exception: If the client is not initialised or the API call fails.
        """
        if not self.client:
            raise Exception("AI Client is not initialized. Check your PROJECT_ENDPOINT and ensure you are logged in (e.g. az login).")
            
        try:
            logger.info("Sending message to chat-agent deployment...")
            response = self.client.chat.completions.create(
                model="chat-agent",
                messages=[
                    {"role": "user", "content": user_message}
                ]
            )
            return response.choices[0].message.content
            
        except Exception as e:
            logger.error(f"Error interacting with AI Inference API: {str(e)}")
            raise


ai_agent = AIAgentService()
