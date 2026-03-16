-- Create verification_jobs table to track bulk verification jobs
CREATE TABLE public.verification_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  telegram_username TEXT,
  total_numbers INTEGER NOT NULL DEFAULT 0,
  registered_count INTEGER NOT NULL DEFAULT 0,
  not_registered_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Create verification_results table to store individual number results
CREATE TABLE public.verification_results (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES public.verification_jobs(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  is_registered BOOLEAN,
  checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create bot_settings table for configuration
CREATE TABLE public.bot_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  setting_key TEXT NOT NULL UNIQUE,
  setting_value TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for better performance
CREATE INDEX idx_verification_results_job_id ON public.verification_results(job_id);
CREATE INDEX idx_verification_results_is_registered ON public.verification_results(is_registered);
CREATE INDEX idx_verification_jobs_telegram_user_id ON public.verification_jobs(telegram_user_id);
CREATE INDEX idx_verification_jobs_status ON public.verification_jobs(status);

-- Enable RLS
ALTER TABLE public.verification_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_settings ENABLE ROW LEVEL SECURITY;

-- Public read policies for dashboard (no auth required for demo)
CREATE POLICY "Allow public read for verification_jobs"
ON public.verification_jobs FOR SELECT
USING (true);

CREATE POLICY "Allow public read for verification_results"
ON public.verification_results FOR SELECT
USING (true);

CREATE POLICY "Allow public read for bot_settings"
ON public.bot_settings FOR SELECT
USING (true);

-- Allow inserts from edge functions (service role)
CREATE POLICY "Allow service role insert for verification_jobs"
ON public.verification_jobs FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow service role insert for verification_results"
ON public.verification_results FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow service role update for verification_jobs"
ON public.verification_jobs FOR UPDATE
USING (true);

CREATE POLICY "Allow service role insert for bot_settings"
ON public.bot_settings FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow service role update for bot_settings"
ON public.bot_settings FOR UPDATE
USING (true);