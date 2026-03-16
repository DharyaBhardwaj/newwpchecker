-- Enable extensions needed for scheduled backend jobs
create extension if not exists pg_cron;
create extension if not exists pg_net;