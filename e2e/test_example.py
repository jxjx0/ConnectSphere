import os
import unittest
#copied from labs 9
from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:5173/")

class TestSample(unittest.TestCase):
    #Setup and teardown methods for the test class
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

    #real test (this one is for passing test)(put in pklaywright test)
    def test_pass(self):
        return self.assertTrue(True)

if __name__ == "__main__":
    unittest.main()