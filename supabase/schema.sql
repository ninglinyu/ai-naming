-- ============================================================
-- AI 起名 · Supabase 建表脚本（多模型版）
-- 用法：Supabase 控制台 → SQL Editor → 新建查询 → 粘贴执行
-- ============================================================

-- 1. 起名记录表
create table if not exists public.naming_records (
  id            uuid primary key default gen_random_uuid(),
  requirement   text        not null,                       -- 用户起名需求（拼装后的完整文本）
  names         jsonb       not null default '[]'::jsonb,   -- 解析出的三组方案 [{label,name,detail}]
  raw_output    text,                                       -- 模型原始输出（完整 markdown）
  model         text        not null,                       -- 使用的模型，如 deepseek-chat
  provider      text        not null default '',            -- 模型来源：doubao / deepseek / qwen / kimi
  status        text        not null default 'streaming',   -- streaming / success / failed
  error_message text,                                       -- 失败原因
  token_usage   jsonb,                                      -- 模型返回的 usage（若接口提供）
  latency_ms    integer,                                    -- 生成耗时（毫秒）
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 兼容阶段 1 已建过表的情况：补 provider 字段（可重复执行）
alter table public.naming_records
  add column if not exists provider text not null default '';

-- 2. 常用索引：按时间倒序查最近记录
create index if not exists naming_records_created_at_idx
  on public.naming_records (created_at desc);

create index if not exists naming_records_provider_idx
  on public.naming_records (provider);

-- 3. 字段注释
comment on table  public.naming_records             is 'AI 起名记录';
comment on column public.naming_records.requirement is '用户起名需求';
comment on column public.naming_records.names       is '生成的名字方案（JSON 数组）';
comment on column public.naming_records.model       is '本次使用的模型';
comment on column public.naming_records.provider    is '模型来源：doubao / deepseek / qwen / kimi';

-- 4. updated_at 自动刷新
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists naming_records_touch on public.naming_records;

create trigger naming_records_touch
  before update on public.naming_records
  for each row execute function public.touch_updated_at();

-- 5. 开启行级安全（RLS）
alter table public.naming_records enable row level security;

-- 权限说明：
-- /api/name 在服务端用 SUPABASE_SERVICE_ROLE_KEY 读写，service_role 自带绕过 RLS 的权限，
-- 前端页面完全不接触 Supabase，也不接触任何密钥。
-- 因此这里默认不向 anon 开放任何策略，匿名用户既读不到也写不了。
--
-- 调试阶段省事做法（仅本地/课堂演示）：注释掉上面那句 enable row level security，
-- 或显式放开 anon 读写，测完记得改回来：
-- create policy "naming_records_anon_read"
--   on public.naming_records for select to anon using (true);
-- create policy "naming_records_anon_insert"
--   on public.naming_records for insert to anon with check (true);
-- create policy "naming_records_anon_update"
--   on public.naming_records for update to anon using (true) with check (true);
--
-- 正式上线只保留 RLS 开启 + service_role 服务端访问，上面三条策略不要执行。

-- 6. 验证（执行完可跑一下，应返回空结果而不是报错）
-- select id, requirement, model, provider, status, created_at
-- from public.naming_records order by created_at desc limit 5;
