#!/usr/bin/env python3
"""
Dynamic NVIDIA NIM Sync for LiteLLM
Additive-only: syncs NVIDIA NIM models to a running LiteLLM Proxy without
touching Ollama or other local provider entries.
"""

import os
import re
import sys

import requests
from dotenv import load_dotenv
from loguru import logger
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Load from ~/.litellm.env (shared with LiteLLM on this machine)
_env_path = os.path.expanduser("~/.litellm.env")
load_dotenv(dotenv_path=_env_path)

NVIDIA_API_BASE = "https://integrate.api.nvidia.com/v1"
NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "")
LITELLM_BASE_URL = os.getenv("LITELLM_BASE_URL", "http://localhost:4000")
LITELLM_MASTER_KEY = os.getenv("LITELLM_MASTER_KEY", "")
FILTER_INSTRUCT_ONLY = os.getenv("FILTER_INSTRUCT_ONLY", "false").lower() == "true"

# Any model whose params contain these strings is treated as local/Ollama — never touched.
LOCAL_SIGNALS = ["ollama", "ollama_chat", "127.0.0.1", "localhost", "0.0.0.0", "192.168."]


# ---------------------------------------------------------------------------
# HTTP session with retry
# ---------------------------------------------------------------------------

def make_session(total_retries: int = 3, backoff: float = 0.5) -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=total_retries,
        backoff_factor=backoff,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET", "POST"],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


# ---------------------------------------------------------------------------
# NVIDIA API client
# ---------------------------------------------------------------------------

class NvidiaClient:
    def __init__(self, api_key: str, session: requests.Session) -> None:
        self._key = api_key
        self._session = session

    def fetch_models(self) -> list[dict]:
        url = f"{NVIDIA_API_BASE}/models"
        logger.info(f"Fetching NVIDIA NIM catalogue from {url}")
        resp = self._session.get(
            url,
            headers={"Authorization": f"Bearer {self._key}"},
            timeout=30,
        )
        resp.raise_for_status()
        models: list[dict] = resp.json().get("data", [])
        logger.info(f"Received {len(models)} models from NVIDIA API")
        return models


# ---------------------------------------------------------------------------
# LiteLLM management client
# ---------------------------------------------------------------------------

class LiteLLMClient:
    def __init__(self, base_url: str, master_key: str, session: requests.Session) -> None:
        self._base = base_url.rstrip("/")
        self._session = session
        self._headers = {
            "Authorization": f"Bearer {master_key}",
            "Content-Type": "application/json",
        }

    def get_registered_models(self) -> list[dict]:
        url = f"{self._base}/model/info"
        logger.info("Fetching registered models from LiteLLM /model/info")
        resp = self._session.get(url, headers=self._headers, timeout=30)
        resp.raise_for_status()
        models: list[dict] = resp.json().get("data", [])
        logger.info(f"LiteLLM has {len(models)} registered models")
        return models

    def register_model(self, model_name: str, litellm_params: dict) -> bool:
        url = f"{self._base}/model/new"
        payload = {
            "model_name": model_name,
            "litellm_params": litellm_params,
            # model_info.id tells the PostgreSQL-backed store what key to use,
            # so this entry survives proxy restarts.
            "model_info": {"id": model_name},
        }
        resp = self._session.post(url, headers=self._headers, json=payload, timeout=30)
        if resp.status_code in (200, 201):
            logger.success(f"  + registered  {model_name}")
            return True
        logger.error(f"  ! failed      {model_name}  [{resp.status_code}] {resp.text[:200]}")
        return False


# ---------------------------------------------------------------------------
# Model name builder
# ---------------------------------------------------------------------------

class ModelNameBuilder:
    """
    Naming pattern:  nv-<stripped-model-id>-<version>-<precision>

    Examples
      meta/llama-3.1-8b-instruct          →  nv-llama-3.1-8b-instruct-v1-fp16
      mistralai/mistral-7b-instruct-v0.3  →  nv-mistral-7b-instruct-v0_3-fp16
      nvidia/llama-3.1-nemotron-70b-fp8   →  nv-llama-3.1-nemotron-70b-fp8-v1-fp8
    """

    _VER_RE = re.compile(r"(?:^|[-_])v(\d+(?:[._]\d+)*)", re.IGNORECASE)

    @classmethod
    def build(cls, model_id: str) -> str:
        # Strip org prefix: "meta/llama-3.1-8b-instruct" → "llama-3.1-8b-instruct"
        base = model_id.split("/")[-1].lower()

        # Detect explicit version tag in the name (e.g. "-v0.3", "-v2")
        ver_match = cls._VER_RE.search(base)
        if ver_match:
            raw_ver = ver_match.group(1).replace(".", "_")
            version = f"v{raw_ver}"
        else:
            version = "v1"

        # Detect quantisation / precision hints in the name
        name_lower = base
        if "fp8" in name_lower:
            precision = "fp8"
        elif any(q in name_lower for q in ("int4", "awq", "gptq")):
            precision = "int4"
        elif "int8" in name_lower:
            precision = "int8"
        elif "bf16" in name_lower:
            precision = "bf16"
        else:
            precision = "fp16"

        return f"nv-{base}-{version}-{precision}"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_local_model(litellm_params: dict) -> bool:
    """Return True if a registered model belongs to Ollama or a protected provider."""
    combined = " ".join([
        str(litellm_params.get("model", "")),
        str(litellm_params.get("api_base", "")),
        str(litellm_params.get("api_key", "")),   # catches os.environ/DEEPSEEK_API_KEY etc.
    ]).lower()
    return any(sig.lower() in combined for sig in LOCAL_SIGNALS)


def _already_registered(nvidia_model_id: str, registered: list[dict]) -> bool:
    target = f"nvidia_nim/{nvidia_model_id}"
    return any(
        m.get("litellm_params", {}).get("model") == target
        for m in registered
    )


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class NimSyncOrchestrator:
    def __init__(
        self,
        nvidia: NvidiaClient,
        litellm: LiteLLMClient,
        filter_instruct_only: bool = False,
    ) -> None:
        self._nvidia = nvidia
        self._litellm = litellm
        self._filter_instruct = filter_instruct_only

    def run(self) -> None:
        logger.info("=== NVIDIA NIM → LiteLLM sync started ===")

        nvidia_models = self._nvidia.fetch_models()
        registered = self._litellm.get_registered_models()

        local_count = sum(
            1 for m in registered if _is_local_model(m.get("litellm_params", {}))
        )
        logger.info(f"Protecting {local_count} local/Ollama model(s) — will not be modified")

        added = skipped_dup = skipped_filter = 0

        for model in nvidia_models:
            model_id: str = model.get("id", "")
            if not model_id:
                continue

            # Optional: restrict to chat/instruct models only
            if self._filter_instruct and "instruct" not in model_id.lower():
                skipped_filter += 1
                continue

            # Skip duplicates (state-aware, no re-registration)
            if _already_registered(model_id, registered):
                logger.debug(f"  = exists      {model_id}")
                skipped_dup += 1
                continue

            model_name = ModelNameBuilder.build(model_id)

            litellm_params = {
                "model": f"nvidia_nim/{model_id}",
                # Reference the env var rather than embedding the raw key in the DB.
                "api_key": "os.environ/NVIDIA_API_KEY",
                "api_base": NVIDIA_API_BASE,
            }

            # Extra guard: should never trigger here, but prevents any accidental
            # local model slipping through if NVIDIA returns an unusual ID.
            if _is_local_model(litellm_params):
                logger.warning(f"  ? skipping suspected local model: {model_id}")
                continue

            if self._litellm.register_model(model_name, litellm_params):
                added += 1

        logger.info(
            f"=== Sync complete — added: {added} | "
            f"already present: {skipped_dup} | "
            f"filtered: {skipped_filter} ==="
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    logger.remove()
    logger.add(
        sys.stderr,
        level="DEBUG",
        colorize=True,
        format="<green>{time:HH:mm:ss}</green> | <level>{level:<8}</level> | {message}",
    )

    if not NVIDIA_API_KEY:
        logger.error("NVIDIA_API_KEY is not set in environment — aborting")
        sys.exit(1)
    if not LITELLM_MASTER_KEY:
        logger.error("LITELLM_MASTER_KEY is not set in environment — aborting")
        sys.exit(1)

    session = make_session()
    orchestrator = NimSyncOrchestrator(
        nvidia=NvidiaClient(api_key=NVIDIA_API_KEY, session=session),
        litellm=LiteLLMClient(
            base_url=LITELLM_BASE_URL,
            master_key=LITELLM_MASTER_KEY,
            session=session,
        ),
        filter_instruct_only=FILTER_INSTRUCT_ONLY,
    )
    orchestrator.run()


if __name__ == "__main__":
    main()
