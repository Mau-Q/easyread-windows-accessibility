"""Transient download recovery must preserve limits, TLS and final source identity."""
import ssl
import subprocess
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock, patch

from easyread import sources

URL = "https://arxiv.org/html/2505.12762v1"


class SourceTransportTest(unittest.TestCase):
    def response(self, content=b"paper"):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = content
        response.headers = {"Content-Type": "text/html"}
        response.geturl.return_value = URL
        return response

    def test_temporary_connection_failure_retries_same_request(self):
        with patch.object(sources.urllib.request, "urlopen", side_effect=[
                urllib.error.URLError(ssl.SSLEOFError("EOF")), self.response()]) as request, \
                patch.object(sources.time, "sleep"), patch.object(sources, "_get_curl") as curl:
            self.assertEqual(sources._get(URL), (b"paper", "text/html", URL))
        self.assertEqual(request.call_count, 2)
        self.assertIs(request.call_args_list[0].args[0], request.call_args_list[1].args[0])
        curl.assert_not_called()

    def test_repeated_tls_eof_uses_bounded_fallback(self):
        with patch.object(sources.urllib.request, "urlopen", side_effect=urllib.error.URLError(ssl.SSLEOFError("EOF"))), \
                patch.object(sources.time, "sleep"), \
                patch.object(sources, "_get_curl", return_value=(b"body", "text/html", URL)) as curl:
            self.assertEqual(sources._get(URL, "text/html", 20, 1000), (b"body", "text/html", URL))
        curl.assert_called_once_with(URL, "text/html", 20, 1000)

    def test_permanent_http_and_certificate_errors_never_retry(self):
        for error in (urllib.error.HTTPError(URL, 404, "missing", {}, None),
                      urllib.error.URLError(ssl.SSLCertVerificationError("bad certificate"))):
            with self.subTest(error=error), patch.object(sources.urllib.request, "urlopen", side_effect=error) as request, \
                    patch.object(sources, "_get_curl") as curl, patch.object(sources.time, "sleep") as sleep:
                with self.assertRaises(sources.SourceError):
                    sources._get(URL)
                self.assertEqual(request.call_count, 1)
                curl.assert_not_called()
                sleep.assert_not_called()

    def test_size_limit_is_not_retried_or_bypassed(self):
        with patch.object(sources.urllib.request, "urlopen", return_value=self.response(b"too long")), \
                patch.object(sources, "_get_curl") as curl:
            with self.assertRaisesRegex(sources.SourceError, "下载上限"):
                sources._get(URL, limit=3)
        curl.assert_not_called()

    def test_curl_preserves_actual_redirect_url_and_checks_size(self):
        final = URL.replace("v1", "v2")
        def download(cmd, **kwargs):
            self.assertNotIn("--insecure", cmd)
            self.assertNotIn("-k", cmd)
            self.assertIn("--max-filesize", cmd)
            Path(cmd[cmd.index("--output") + 1]).write_bytes(b"paper")
            return subprocess.CompletedProcess(cmd, 0, (final + "\ntext/html\n").encode(), b"")
        with patch.object(sources.shutil, "which", return_value="/usr/bin/curl"), \
                patch.object(sources.subprocess, "run", side_effect=download):
            self.assertEqual(sources._get_curl(URL, "text/html", 20, 100), (b"paper", "text/html", final))
            with self.assertRaisesRegex(sources.SourceError, "下载上限"):
                sources._get_curl(URL, "text/html", 20, 3)


if __name__ == "__main__":
    unittest.main()
