"""Send one real notification end to end: saved in Supabase + emailed.

Run from the backend folder, with the venv active:

    python -m scripts.send_test_notification <user_id>

<user_id> is a row id from the `profiles` table. The email goes to that
user's login email address. Check the spam folder if it does not arrive.
"""

import logging
import sys

from services.notification_service import notify


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: python -m scripts.send_test_notification <user_id>")
        sys.exit(1)

    # Show notify()'s logged errors in the terminal.
    logging.basicConfig(level=logging.INFO)

    notification = notify(
        sys.argv[1],
        "test",
        "ConnectSphere test notification",
        "If you can read this, ConnectSphere notifications are working.",
    )
    if notification is None:
        print("Failed: the notification was not saved. See the error above.")
        sys.exit(1)
    print(f"Saved notification {notification.id}.")
    print("If no email error is shown above, check the inbox (and spam).")


if __name__ == "__main__":
    main()
