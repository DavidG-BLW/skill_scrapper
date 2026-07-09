-- Master report table
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  report_id text unique,
  date_key date not null,
  theme_key text not null,
  theme_label text,
  filename text,
  ai_analysis jsonb, -- Almacena el análisis consolidado por IA (resumen ejecutivo, recomendaciones, etc.)
  created_at timestamptz default now()
);

-- 1. Scraped posts table (To store every individual post parsed from Apify scrapers)
create table if not exists scraped_posts (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references reports(id) on delete cascade,
  url text,
  text text,
  username text,
  platform text,
  published_date timestamptz,
  likes int default 0,
  comments_count int default 0,
  shares int default 0,
  retweets int default 0,
  bookmarks int default 0,
  views bigint default 0,
  followers int default 0,
  thumbnail text,
  sentiment text, -- 'positive', 'neutral', 'negative'
  theme_key text,
  created_at timestamptz default now()
);

-- 2. Scraped comments table (To store individual comments belonging to scraped posts)
create table if not exists scraped_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid references scraped_posts(id) on delete cascade,
  text text,
  author text,
  published_time timestamptz,
  likes int default 0,
  replies int default 0,
  views int default 0,
  url text,
  created_at timestamptz default now()
);

-- 3. Persistent allies and contrarios (voices) per report
create table if not exists allies_critics_voices (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references reports(id) on delete cascade,
  username text not null,
  platform text,
  sentiment text, -- 'positive', 'neutral', 'negative'
  followers int default 0,
  posts_count int default 0,
  total_engagement int default 0,
  likes_count int default 0,
  comments_count int default 0,
  tier text, -- 'macro', 'medio', 'micro'
  keywords jsonb, -- array of triggered words, e.g. ["chisme", "crítica"]
  profile_url text,
  theme_key text,
  last_active timestamptz default now(),
  created_at timestamptz default now(),
  constraint unique_voice_per_report unique (report_id, username, platform)
);

-- Enable Row Level Security (RLS) on all tables
alter table reports enable row level security;
alter table scraped_posts enable row level security;
alter table scraped_comments enable row level security;
alter table allies_critics_voices enable row level security;

-- Policies: allow anon read/insert/update/delete (full access) for internal dashboard
create policy "anon_all_reports" on reports for all to anon using (true) with check (true);
create policy "anon_all_scraped_posts" on scraped_posts for all to anon using (true) with check (true);
create policy "anon_all_scraped_comments" on scraped_comments for all to anon using (true) with check (true);
create policy "anon_all_allies_critics_voices" on allies_critics_voices for all to anon using (true) with check (true);
