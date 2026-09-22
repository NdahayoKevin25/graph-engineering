"""Local typed-decision service. Serving never downloads a model or executes text.

The HTTP/validation layer uses Python's standard library. The optional, pinned
Laya/PyTorch dependencies are imported only by the real prediction runtime.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import secrets
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Protocol
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

SDK_VERSION = "0.3.5"
REPOSITORY = "convaiinnovations/laya"
REVISION = "1c5edc17a7acd8701df6fc341c0d179f1c62c982"
CHECKPOINTS = {"english": "", "multilingual": "multilingual/", "typed-decisions": "typed-decisions/"}
ASSETS = ("rl_agent_config.json", "encoder/config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json", "model.safetensors")
MAX_REQUEST_BYTES = 64 * 1024
IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:+/-]{1,100}$")


def model_identity(checkpoint: str) -> str:
    return f"laya-{checkpoint}@{REVISION}/sdk{SDK_VERSION}/prob-v1"


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_download_url(url: str, hosts: set[str]) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.hostname not in hosts:
        raise ValueError(f"Download host is not permitted: {parsed.hostname}")


class CheckedRedirects(HTTPRedirectHandler):
    def __init__(self, hosts: set[str]):
        self.hosts = hosts

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        validate_download_url(newurl, self.hosts)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def provision(directory: Path, checkpoint: str, allowed_hosts: set[str]) -> dict:
    """Explicit installation only; checkpoint selection never occurs in serving."""
    if checkpoint not in CHECKPOINTS:
        raise ValueError("Unknown checkpoint")
    if not allowed_hosts:
        raise ValueError("Provisioning requires explicit --allow-host entries")
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (directory / "manifest.json").exists():
        manifest = verify_assets(directory)
        if manifest["checkpoint"] != checkpoint:
            raise ValueError("This directory contains a different checkpoint")
        return manifest
    opener = build_opener(CheckedRedirects(allowed_hosts))
    for asset in ASSETS:
        url = f"https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{CHECKPOINTS[checkpoint]}{asset}"
        validate_download_url(url, allowed_hosts)
        target = directory / asset
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if target.is_symlink() or not target.parent.resolve().is_relative_to(directory):
            raise ValueError("Model path escapes the installation directory")
        descriptor, temporary = tempfile.mkstemp(prefix="download-", suffix=".tmp", dir=target.parent)
        try:
            with os.fdopen(descriptor, "wb") as destination, opener.open(Request(url), timeout=120) as response:
                total = 0
                while block := response.read(1024 * 1024):
                    total += len(block)
                    if total > 2_000_000_000:
                        raise ValueError("Model asset exceeds the two-gigabyte limit")
                    destination.write(block)
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
    # Laya 0.3.5 normalizes this config on first load. Perform that exact
    # compatibility normalization before hashing, keeping serving read-only.
    config_path = directory / "tokenizer/tokenizer_config.json"
    config = json.loads(config_path.read_text())
    if config.get("tokenizer_class") in (None, "TokenizersBackend"):
        config["tokenizer_class"] = "PreTrainedTokenizerFast"
        config.pop("backend", None)
        config.pop("is_local", None)
    extra = config.get("extra_special_tokens")
    if isinstance(extra, list):
        config["extra_special_tokens"] = {f"extra_{index}": token for index, token in enumerate(extra)}
    config_path.write_text(json.dumps(config, indent=2))
    manifest = {"version": 1, "repository": REPOSITORY, "revision": REVISION, "sdk": SDK_VERSION,
                "checkpoint": checkpoint, "model": model_identity(checkpoint),
                "tokenizerNormalization": "laya-0.3.5-compatibility", "assets": {asset: file_hash(directory / asset) for asset in ASSETS}}
    manifest_path = directory / "manifest.json"
    with manifest_path.open("x", encoding="utf8") as target:
        json.dump(manifest, target, indent=2)
    return manifest


def verify_assets(directory: Path) -> dict:
    directory = directory.resolve(strict=True)
    manifest = json.loads((directory / "manifest.json").read_text())
    checkpoint = manifest.get("checkpoint")
    if checkpoint not in CHECKPOINTS or manifest.get("revision") != REVISION or manifest.get("sdk") != SDK_VERSION or manifest.get("model") != model_identity(checkpoint):
        raise ValueError("Model manifest does not match the pinned runtime")
    for asset in ASSETS:
        target = directory / asset
        if target.is_symlink() or not target.resolve(strict=True).is_relative_to(directory) or manifest.get("assets", {}).get(asset) != file_hash(target):
            raise ValueError(f"Model asset missing or changed: {asset}")
    return manifest


class Predictor(Protocol):
    model_id: str
    max_len: int
    head_max_len: int
    mask_token: str
    device: str

    def token_count(self, text: str) -> int: ...
    def predict(self, state: Any, questions: dict) -> dict: ...


class LayaPredictor:
    def __init__(self, directory: Path, device: str):
        manifest = verify_assets(directory)
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        if importlib.metadata.version("laya") != SDK_VERSION:
            raise RuntimeError(f"Install the pinned laya=={SDK_VERSION} dependencies first")
        import laya  # Deliberately lazy: stdlib tests do not import/download torch.
        self.agent = laya.load(str(directory.resolve(strict=True)), device=device)
        self.model_id = manifest["model"]
        self.max_len = int(self.agent.cfg.get("max_len", 512))
        self.head_max_len = int(self.agent.cfg.get("head_max_len", 192))
        self.mask_token = self.agent.tok.mask_token
        self.device = str(self.agent.device)
        if self.device != device:
            raise RuntimeError(f"Requested {device}, but runtime selected {self.device}; configure the actual device explicitly")

    def token_count(self, text: str) -> int:
        return len(self.agent.tok(text, add_special_tokens=False)["input_ids"])

    def predict(self, state: Any, questions: dict) -> dict:
        return self.agent.predict(state, questions)


def render_options(question: dict) -> list[str]:
    kind, criteria = question["type"], question.get("criteria")
    if kind == "choice":
        return [name if not description else f"{name}: {description}" for name, description in criteria.items()]
    if kind == "score":
        return [f"level {index}: {description}" for index, description in enumerate(criteria)]
    criteria = criteria or {}
    return ["false: " + (criteria.get("false") or "no, the statement does not hold"),
            "true: " + (criteria.get("true") or "yes, the statement holds")]


def validate_request(payload: Any, predictor: Predictor) -> tuple[Any, dict]:
    if not isinstance(payload, dict) or set(payload) != {"model", "state", "questions"}:
        raise ValueError("Expected model, state, and questions")
    if payload["model"] != predictor.model_id:
        raise ValueError("Requested model does not match the pinned served model")
    state, questions = payload["state"], payload["questions"]
    if not isinstance(state, (str, dict, list)):
        raise ValueError("State must be text or a JSON object/array")
    state_text = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
    if len(state_text) > 16384 or not isinstance(questions, dict) or not 1 <= len(questions) <= 12:
        raise ValueError("State or question count exceeds limits")
    count = lambda text: predictor.token_count(text.replace(predictor.mask_token, " "))
    state_tokens = count(state_text)
    for name, question in questions.items():
        if not IDENTIFIER.fullmatch(name) or not isinstance(question, dict) or set(question) - {"type", "instructions", "criteria"}:
            raise ValueError("Invalid question shape")
        kind = question.get("type")
        instructions = question.get("instructions")
        if kind not in {"choice", "score", "noul"} or not isinstance(instructions, str) or not instructions.strip() or len(instructions) > 1000:
            raise ValueError("Invalid question type or instructions")
        criteria = question.get("criteria")
        if kind == "choice":
            if not isinstance(criteria, dict) or not 1 <= len(criteria) <= 12 or any(not IDENTIFIER.fullmatch(key) or not isinstance(value, str) for key, value in criteria.items()):
                raise ValueError("Choices require 1–12 named string criteria")
        elif kind == "score":
            if not isinstance(criteria, list) or not 2 <= len(criteria) <= 12 or any(not isinstance(value, str) for value in criteria):
                raise ValueError("Scores require 2–12 string levels")
        elif criteria is not None and (not isinstance(criteria, dict) or set(criteria) - {"false", "true"} or any(not isinstance(value, str) for value in criteria.values())):
            raise ValueError("Noul criteria must describe false/true")
        option_counts = [count(" " + option) for option in render_options(question)]
        if any(length > 48 for length in option_counts):
            raise ValueError("Option exceeds Laya's 48-token per-option limit")
        option_tokens = sum(1 + length for length in option_counts)
        instruction_tokens = count(f"{kind} question: {instructions}")
        instruction_budget = predictor.head_max_len - option_tokens
        if instruction_budget < 16 or instruction_tokens > max(8, instruction_budget):
            raise ValueError("Question exceeds checkpoint head budget; shorten options/instructions")
        state_budget = predictor.max_len - instruction_tokens - option_tokens - 4
        if state_tokens > state_budget:
            raise ValueError(f"State exceeds checkpoint budget ({state_tokens} > {state_budget} tokens); no truncation allowed")
    return state, questions


def normalize_result(result: dict, questions: dict, predictor: Predictor) -> dict:
    answers = result.get("answers")
    if not isinstance(answers, dict) or set(answers) != set(questions):
        raise ValueError("Predictor returned an invalid answer set")
    for name, question in questions.items():
        answer = answers[name]
        if not isinstance(answer, dict):
            raise ValueError("Predictor returned an invalid answer")
        confidence = answer.get("confidence")
        if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError("Predictor returned invalid confidence")
        if question["type"] == "choice":
            choice, probabilities = answer.get("choice"), answer.get("probabilities")
            if choice not in question["criteria"] or not isinstance(probabilities, dict) or set(probabilities) != set(question["criteria"]):
                raise ValueError("Predictor returned a choice outside the permitted set")
            values = list(probabilities.values())
            if any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or not 0 <= value <= 1 for value in values) or abs(sum(values) - 1) > 0.01:
                raise ValueError("Predictor returned invalid probabilities")
            answer["laya_entropy_confidence"] = confidence
            answer["confidence"] = probabilities[choice]
        elif question["type"] == "score":
            score = answer.get("score")
            if not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= len(question["criteria"]) - 1:
                raise ValueError("Predictor returned an invalid score")
        else:
            probability = answer.get("noul")
            if not isinstance(probability, (int, float)) or not math.isfinite(probability) or not 0 <= probability <= 1:
                raise ValueError("Predictor returned an invalid probability")
    return {"model": predictor.model_id, "answers": answers, "usage": result.get("usage", {}),
            "runtime": {"device": predictor.device, "max_tokens": predictor.max_len,
                        "choice_confidence": "selected_class_probability_uncalibrated", "sdk": SDK_VERSION}}


class DecisionService:
    def __init__(self, predictor: Predictor, token: str):
        if len(token) < 32:
            raise ValueError("Bearer token must contain at least 32 characters")
        self.predictor, self.token = predictor, token
        self.lock = threading.Lock()

    def handler(self):
        service = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "GraphLaya/1"

            def setup(self):
                super().setup()
                self.connection.settimeout(10)

            def log_message(self, format, *args):
                pass  # Requests, states and credentials never enter stdout logs.

            def respond(self, code: int, payload: dict):
                body = json.dumps(payload, allow_nan=False).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def authorized(self) -> bool:
                # No browser CORS exposure or DNS-rebinding hostnames.
                hostname = self.headers.get("Host", "").split(":", 1)[0]
                if hostname not in {"127.0.0.1", "localhost"} or self.headers.get("Origin"):
                    self.respond(403, {"error": "Local authenticated clients only"})
                    return False
                if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + service.token):
                    self.respond(401, {"error": "Authentication required"})
                    return False
                return True

            def do_GET(self):
                if not self.authorized():
                    return
                if self.path != "/health":
                    self.respond(404, {"error": "Not found"})
                    return
                self.respond(200, {"model": service.predictor.model_id, "device": service.predictor.device, "offline": True})

            def do_POST(self):
                if not self.authorized():
                    return
                if self.path not in {"/v1/decide", "/v1/system-one"}:
                    self.respond(404, {"error": "Not found"})
                    return
                if self.headers.get("Transfer-Encoding") or self.headers.get_content_type() != "application/json":
                    self.respond(400, {"error": "Use a JSON body with Content-Length"})
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= MAX_REQUEST_BYTES:
                        self.respond(413, {"error": "Request exceeds body limit"})
                        return
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise ValueError("Incomplete request body")
                    payload = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite JSON value")))
                    state, questions = validate_request(payload, service.predictor)
                except (ValueError, TypeError, KeyError, TimeoutError) as error:
                    self.respond(400, {"error": str(error)})
                    return
                if not service.lock.acquire(blocking=False):
                    self.respond(503, {"error": "Decision engine busy; retry within caller budget"})
                    return
                try:
                    result = normalize_result(service.predictor.predict(state, questions), questions, service.predictor)
                    self.respond(200, result)
                except Exception:
                    self.respond(500, {"error": "Prediction failed; abstain and retain the deterministic baseline"})
                finally:
                    service.lock.release()

        return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser("provision")
    install.add_argument("--directory", type=Path, required=True)
    install.add_argument("--checkpoint", choices=CHECKPOINTS, default="english")
    install.add_argument("--allow-host", action="append", default=[])
    serve = commands.add_parser("serve")
    serve.add_argument("--directory", type=Path, required=True)
    serve.add_argument("--device", choices=["cpu", "mps"], default="cpu")
    serve.add_argument("--port", type=int, default=7337)
    serve.add_argument("--container", action="store_true", help="Bind container interface; publish Docker port on host 127.0.0.1 only")
    commands.add_parser("token")
    args = parser.parse_args()
    if args.command == "token":
        print(secrets.token_urlsafe(32))
    elif args.command == "provision":
        print(json.dumps(provision(args.directory, args.checkpoint, set(args.allow_host)), indent=2))
    else:
        if not 1 <= args.port <= 65535:
            parser.error("Port must be between 1 and 65535")
        if args.container and os.environ.get("GRAPH_LAYA_CONTAINER") != "1":
            parser.error("--container is only available in the supplied container image")
        token = os.environ.get("GRAPH_LAYA_TOKEN", "")
        if len(token) < 32:
            parser.error("Set GRAPH_LAYA_TOKEN to a token of at least 32 characters")
        predictor = LayaPredictor(args.directory, args.device)
        server = ThreadingHTTPServer(("0.0.0.0" if args.container else "127.0.0.1", args.port), DecisionService(predictor, token).handler())
        print(json.dumps({"event": "ready", "model": predictor.model_id, "device": predictor.device, "port": args.port}), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
