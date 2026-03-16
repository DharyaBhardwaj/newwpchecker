-- Create admin roles enum
CREATE TYPE public.app_role AS ENUM ('admin', 'user');

-- Create user_roles table for admin management
CREATE TABLE public.user_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL, -- telegram_user_id
    role app_role NOT NULL DEFAULT 'user',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (user_id, role)
);

-- Enable RLS
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Allow public read for user_roles
CREATE POLICY "Allow public read for user_roles"
ON public.user_roles
FOR SELECT
USING (true);

-- Allow service role to manage user_roles
CREATE POLICY "Allow service role insert for user_roles"
ON public.user_roles
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow service role update for user_roles"
ON public.user_roles
FOR UPDATE
USING (true);

CREATE POLICY "Allow service role delete for user_roles"
ON public.user_roles
FOR DELETE
USING (true);

-- Security definer function to check admin role
CREATE OR REPLACE FUNCTION public.is_admin(_telegram_user_id BIGINT)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _telegram_user_id
      AND role = 'admin'
  )
$$;

-- Create daily_stats table for analytics
CREATE TABLE public.daily_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL UNIQUE,
    total_checks INTEGER NOT NULL DEFAULT 0,
    registered_count INTEGER NOT NULL DEFAULT 0,
    not_registered_count INTEGER NOT NULL DEFAULT 0,
    unique_users INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on daily_stats
ALTER TABLE public.daily_stats ENABLE ROW LEVEL SECURITY;

-- Allow public read for daily_stats
CREATE POLICY "Allow public read for daily_stats"
ON public.daily_stats
FOR SELECT
USING (true);

-- Allow service role to manage daily_stats
CREATE POLICY "Allow service role insert for daily_stats"
ON public.daily_stats
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow service role update for daily_stats"
ON public.daily_stats
FOR UPDATE
USING (true);

-- Add blocked column to subscriptions table
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT false;

-- Add last_active column to subscriptions table
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS last_active TIMESTAMP WITH TIME ZONE;