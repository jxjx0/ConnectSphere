import os
import unittest
from datetime import datetime, timedelta

from playwright.sync_api import expect, sync_playwright

expect.set_options(timeout=20000)

BASE_URL = os.environ.get("BASE_URL", "http://localhost:5173/")
ORGANISER_EMAIL = "maggiemee3103+organiser@gmail.com"
ORGANISER_PASSWORD = "password"


class TestOrganiser(unittest.TestCase):
    """Visual checks for the organiser event-request form; no drafts are persisted."""

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
        self.page.set_default_timeout(20000)
        self.page.goto(BASE_URL)

    def tearDown(self):
        self.context.close()

    def test_event_request_form_and_local_validation(self):
        """Check form fields, session controls, review screen, and client-side validation.

        The test deliberately avoids saving, submitting, or deleting a draft.
        """
        page = self.page
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

        page.get_by_role("textbox", name="Event name").fill("Visual test event")
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
        page.get_by_role("button", name="Review request").click()
        expect(page.get_by_role("heading", name="Review your request")).to_be_visible()
        expect(page.get_by_text("Visual test event")).to_be_visible()
        expect(page.get_by_role("heading", name="Sessions (1)")).to_be_visible()

        page.get_by_role("button", name="Back to edit").click()
        page.get_by_role("textbox", name="Starts").fill(
            (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M")
        )
        page.get_by_role("button", name="Review request").click()
        expect(page.get_by_role("alert")).to_contain_text(
            "Test1: Start time must be in the future."
        )
        page.get_by_role("button", name="Log out").click()


if __name__ == "__main__":
    unittest.main()
