import os
import unittest

from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:5173/")


class TestSample(unittest.TestCase):
    """Playwright runner scaffold; this is not a product-flow or visual test."""

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.page = self.context.new_page()
        self.page.goto(BASE_URL)

    def tearDown(self):
        self.page.close()
        self.context.close()

    def test_pass(self):
        """Smoke-check unittest discovery without navigating or changing app data."""
        return self.assertTrue(True)

if __name__ == "__main__":
    unittest.main()