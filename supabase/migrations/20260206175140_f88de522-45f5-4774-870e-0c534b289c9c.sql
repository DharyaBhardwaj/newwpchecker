-- Insert default bot enabled setting
INSERT INTO public.bot_settings (setting_key, setting_value) 
VALUES ('bot_enabled', 'true')
ON CONFLICT (setting_key) DO NOTHING;

-- Add owner_telegram_id setting to track bot owner
INSERT INTO public.bot_settings (setting_key, setting_value) 
VALUES ('owner_telegram_id', '')
ON CONFLICT (setting_key) DO NOTHING;