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

    def tearDown(self):
        self.page.close()
        self.context.close()

    #real test (this one is for passing test)(put in pklaywright test)
    def test_login_attendee(self):
            self.page.locator("#main-content").get_by_role("link", name="Log in").click()
            self.page.get_by_role("textbox", name="Email address").click()
            self.page.get_by_role("textbox", name="Email address").fill("maggie3103+attendee@gmail.com")
            self.page.get_by_role("textbox", name="Email address").dblclick()
            self.page.get_by_role("textbox", name="Email address").click()
            self.page.get_by_role("textbox", name="Email address").fill("maggieme3103+attendee@gmail.com")
            self.page.get_by_role("textbox", name="Password").click()
            self.page.get_by_role("textbox", name="Password").fill("pa")
            self.page.get_by_role("textbox", name="Email address").click()
            self.page.get_by_role("textbox", name="Email address").fill("maggiemee3103+attendee@gmail.com")
            self.page.get_by_role("textbox", name="Password").click()
            self.page.get_by_role("textbox", name="Password").fill("password")
            self.page.get_by_role("textbox", name="Password").press("Enter")
            self.page.get_by_role("heading", name="Sign up for Events here!").click()
            expect(self.page.get_by_role("heading", name="Sign up for Events here!")).to_be_visible()

if __name__ == "__main__":
    unittest.main()