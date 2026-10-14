-- Links a developer application to the Telegram chat that confirmed it, so we can message them
-- directly (approved/rejected) instead of relying only on email. Set when they click the
-- "Get notified on Telegram" link after submitting (t.me/OmarchyStoreBot?start=dev_<id>).
ALTER TABLE developers ADD COLUMN telegram_chat_id INTEGER;
