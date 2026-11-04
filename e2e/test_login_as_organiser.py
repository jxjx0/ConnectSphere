import os
import re
import unittest
from datetime import datetime, timedelta
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:5173/")
ORGANISER_EMAIL = "maggiemee3103+organiser@gmail.com"
ORGANISER_PASSWORD = "password"


class TestOrganiser(unittest.TestCase):
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
        self.context.close()

    def test_create_save_validate_and_delete_event_draft(self):
        page = self.page
        event_name = f"Test123-{uuid4().hex[:8]}"
        start = datetime.now() + timedelta(days=5)
        end = start + timedelta(days=3)

        expect(
            page.get_by_role("heading", name="Bring people together. Make")
        ).to_be_visible()
        page.locator("#main-content").get_by_role(
            "link", name="Log in"
        ).click()
        page.get_by_role("textbox", name="Email address").fill(ORGANISER_EMAIL)
        page.get_by_role("textbox", name="Password").fill(ORGANISER_PASSWORD)
        page.get_by_role("button", name="Log in").click()

        expect(page.get_by_role("link", name="My events")).to_be_visible()
        expect(page.get_by_role("link", name="New event")).to_be_visible()
        expect(page.get_by_role("heading", name="My Events")).to_be_visible()
        page.get_by_role("link", name="New event").click()
        expect(page.get_by_role("heading", name="Request an event")).to_be_visible()

        page.get_by_role("textbox", name="Event name").fill(event_name)
        page.get_by_label("Category").select_option("other")
        page.get_by_role("textbox", name="Describe the category").fill("Test")
        page.get_by_role("textbox", name="Purpose").fill("Test")
        page.get_by_role("textbox", name="Description").fill("Test")
        page.get_by_role("textbox", name="Accessibility requirements").fill("Test")
        page.get_by_role("textbox", name="Session name").fill("Test1")
        page.get_by_role("textbox", name="Starts").fill(start.strftime("%Y-%m-%dT%H:%M"))
        page.get_by_role("textbox", name="Ends").fill(end.strftime("%Y-%m-%dT%H:%M"))
        page.get_by_role("spinbutton", name="Expected attendance").fill("150")
        page.get_by_role("textbox", name="Preferred location").fill("test")
        page.get_by_role("textbox", name="Preferred room layout").fill("test")
        page.get_by_role("textbox", name="Equipment requirements").fill("microphone")

        page.get_by_role("button", name="+ Add session").click()
        expect(page.get_by_text("Session 2", exact=True)).to_be_visible()
        page.get_by_role("button", name="Remove Session 2").click()
        page.get_by_role("button", name="Save as draft").click()
        expect(page.get_by_text("Draft saved. You can continue")).to_be_visible()

        page.get_by_role("link", name="Cancel").click()
        page.get_by_role("tab", name=re.compile(r"Drafts")).click()
        page.get_by_role("link", name=re.compile(re.escape(event_name))).click()
        expect(page.get_by_role("heading", name="Continue your draft")).to_be_visible()

        page.get_by_role("textbox", name="Starts").fill(
            (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M")
        )
        page.get_by_role("button", name="Review request").click()
        expect(page.get_by_role("alert")).to_contain_text(
            "Session 1: Start time must be in the future."
        )

        page.once("dialog", lambda dialog: dialog.dismiss())
        page.get_by_role("button", name="Delete draft").click()
        expect(
            page.get_by_role("link", name=re.compile(re.escape(event_name)))
        ).to_have_count(0)
        page.get_by_role("button", name="Log out").click()


if __name__ == "__main__":
    unittest.main()
