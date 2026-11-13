"""Parallel PDF preparation must produce complete images and keep source bytes."""
import hashlib
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image
from pypdf import PdfWriter

from easyread import pdfwork


class PDFWorkTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        writer = PdfWriter()
        for _ in range(8):
            writer.add_blank_page(width=100, height=120)
        writer.write(self.root / "source.pdf")
        self.before = hashlib.sha256((self.root / "source.pdf").read_bytes()).hexdigest()

    def tearDown(self):
        self.assertEqual(hashlib.sha256((self.root / "source.pdf").read_bytes()).hexdigest(), self.before)
        self.folder.cleanup()

    def test_eight_workers_generate_valid_images_and_share_page_cache(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            paths = list(pool.map(lambda n: pdfwork.engine_image(self.root, n), list(range(1, 9)) + [1] * 8))
        for path in paths:
            with Image.open(path) as image:
                self.assertEqual(image.size, (200, 240))
                image.verify()
        self.assertEqual(len(list((self.root / "extract").glob("*.jpg"))), 8)
        self.assertFalse(list((self.root / "extract").glob(".*.jpg")))

    def test_corrupt_derived_cache_is_rebuilt_from_original(self):
        (self.root / "extract").mkdir()
        (self.root / "extract/page-001.jpg").write_bytes(b"partial image")
        with Image.open(pdfwork.engine_image(self.root, 1)) as image:
            image.verify()

    def test_truncated_jpeg_with_valid_header_is_rebuilt(self):
        path = pdfwork.engine_image(self.root, 1)
        complete = path.read_bytes()
        path.write_bytes(complete[:-100])
        self.assertEqual(pdfwork.engine_image(self.root, 1).read_bytes(), complete)

    def test_other_render_paths_can_run_alongside_engine_images(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(pdfwork.render_pages, self.root / "source.pdf", self.root / "pages", 1.0),
                       pool.submit(pdfwork.extract_text, self.root / "source.pdf", self.root / "text"),
                       pool.submit(pdfwork.crop, self.root, 1, [0, 0, 1, 1], "crop", 1.0)]
            futures += [pool.submit(pdfwork.engine_image, self.root, n) for n in range(1, 9)]
            values = [future.result() for future in futures]
        self.assertEqual(len(values[0]), 8)
        self.assertEqual(values[1], 8)
        with Image.open(self.root / values[2]) as image:
            self.assertEqual(image.size, (100, 120))
        self.assertEqual(len(list((self.root / "text").glob("*.txt"))), 8)


if __name__ == "__main__":
    unittest.main()
