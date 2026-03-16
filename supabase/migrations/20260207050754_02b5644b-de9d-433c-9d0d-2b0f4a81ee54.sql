-- Create allowed_users table for whitelist when bot is disabled
CREATE TABLE IF NOT EXISTS public.allowed_users (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL UNIQUE,
    telegram_username TEXT,
    added_by BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.allowed_users ENABLE ROW LEVEL SECURITY;

-- Service role can do anything
CREATE POLICY "Service role full access" 
ON public.allowed_users 
FOR ALL 
USING (true) 
WITH CHECK (true);