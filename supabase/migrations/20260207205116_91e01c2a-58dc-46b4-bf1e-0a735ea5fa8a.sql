-- Create table to store number dispenser pool
CREATE TABLE public.number_dispenser (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_number TEXT NOT NULL,
  country TEXT DEFAULT 'Unknown',
  is_assigned BOOLEAN DEFAULT false,
  assigned_to BIGINT,
  assigned_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for fast lookups
CREATE INDEX idx_number_dispenser_unassigned ON public.number_dispenser(is_assigned) WHERE is_assigned = false;

-- Disable RLS since this is accessed via service role only
ALTER TABLE public.number_dispenser ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role access" ON public.number_dispenser
  FOR ALL USING (true);

-- Enable realtime for the table
ALTER PUBLICATION supabase_realtime ADD TABLE public.number_dispenser;