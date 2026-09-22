import copy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

from server import (ASSETS, DecisionService, SDK_VERSION, REVISION, file_hash,
                    model_identity, normalize_result, validate_download_url,
                    validate_request, verify_assets)


class FakePredictor:
    model_id = model_identity("english")
    max_len = 512
    head_max_len = 192
    mask_token = "[MASK]"
    device = "cpu"
    calls = 0

    def token_count(self, text):
        return len(text.split())

    def predict(self, state, questions):
        self.calls += 1
        return {"answers": {name: {"choice": "local", "confidence": 0.2, "probabilities": {"local": 0.8, "frontier": 0.2}} for name in questions}, "usage": {"input_tokens": 20, "output_tokens": 0}}


def request():
    return {"model": model_identity("english"), "state": {"task": "rename a local variable"},
            "questions": {"action": {"type": "choice", "instructions": "Choose a worker", "criteria": {"local": "simple edits", "frontier": "complex reasoning"}}}}


class ValidationTests(unittest.TestCase):
    def test_compatible_batch_and_probability_semantics(self):
        predictor = FakePredictor()
        payload = request()
        payload["questions"]["review"] = copy.deepcopy(payload["questions"]["action"])
        state, questions = validate_request(payload, predictor)
        result = normalize_result(predictor.predict(state, questions), questions, predictor)
        self.assertEqual(predictor.calls, 1)
        self.assertEqual(result["model"], predictor.model_id)
        self.assertEqual(result["answers"]["action"]["confidence"], 0.8)
        self.assertEqual(result["answers"]["action"]["laya_entropy_confidence"], 0.2)

    def test_state_and_option_truncation_are_rejected(self):
        payload = request()
        payload["state"] = "token " * 600
        with self.assertRaisesRegex(ValueError, "State exceeds"):
            validate_request(payload, FakePredictor())
        payload = request()
        payload["questions"]["action"]["criteria"]["local"] = "token " * 50
        with self.assertRaisesRegex(ValueError, "48-token"):
            validate_request(payload, FakePredictor())
        payload = request()
        payload["questions"]["action"]["instructions"] = "token " * 160
        payload["questions"]["action"]["criteria"] = {str(i): "token " * 20 for i in range(8)}
        with self.assertRaisesRegex(ValueError, "head budget"):
            validate_request(payload, FakePredictor())

    def test_model_identity_and_invalid_answers(self):
        payload = request()
        payload["model"] = "unversioned-model"
        with self.assertRaisesRegex(ValueError, "pinned"):
            validate_request(payload, FakePredictor())
        payload = request()
        result = FakePredictor().predict(payload["state"], payload["questions"])
        result["answers"]["action"]["choice"] = "untrusted"
        with self.assertRaisesRegex(ValueError, "permitted set"):
            normalize_result(result, payload["questions"], FakePredictor())

    def test_download_hosts_and_cache_integrity(self):
        validate_download_url("https://huggingface.co/model", {"huggingface.co"})
        for url in ["http://huggingface.co/model", "https://evil.invalid/model", "https://user:pass@huggingface.co/model"]:
            with self.assertRaises(ValueError):
                validate_download_url(url, {"huggingface.co"})
        with tempfile.TemporaryDirectory(prefix="graph-laya-test-") as tmp:
            directory = Path(tmp)
            for asset in ASSETS:
                target = directory / asset
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("fixture")
            manifest = {"sdk": SDK_VERSION, "revision": REVISION, "checkpoint": "english", "model": model_identity("english"), "assets": {asset: file_hash(directory / asset) for asset in ASSETS}}
            (directory / "manifest.json").write_text(json.dumps(manifest))
            self.assertEqual(verify_assets(directory)["model"], model_identity("english"))
            (directory / "model.safetensors").write_text("changed")
            with self.assertRaisesRegex(ValueError, "changed"):
                verify_assets(directory)


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.predictor = FakePredictor()
        self.token = "test-local-token-" + "x" * 32
        self.service = DecisionService(self.predictor, self.token)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.service.handler())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def call(self, payload=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        merged = {"Content-Type": "application/json", "Authorization": "Bearer " + self.token}
        merged.update(headers or {})
        connection.request("POST", "/v1/decide", json.dumps(payload or request()), merged)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_auth_and_host_boundaries(self):
        self.assertEqual(self.call(headers={"Authorization": "Bearer wrong"})[0], 401)
        self.assertEqual(self.call(headers={"Host": "evil.invalid"})[0], 403)
        self.assertEqual(self.call(headers={"Origin": "https://evil.invalid"})[0], 403)
        self.assertEqual(self.predictor.calls, 0)

    def test_real_http_contract_and_busy_abstention(self):
        code, body = self.call()
        self.assertEqual(code, 200)
        self.assertEqual(body["answers"]["action"]["choice"], "local")
        self.service.lock.acquire()
        try:
            self.assertEqual(self.call()[0], 503)
        finally:
            self.service.lock.release()

    def test_oversized_state_never_reaches_predictor(self):
        payload = request()
        payload["state"] = "token " * 600
        self.assertEqual(self.call(payload)[0], 400)
        self.assertEqual(self.predictor.calls, 0)


if __name__ == "__main__":
    unittest.main()
