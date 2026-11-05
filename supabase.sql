-- ============================================================
-- AI 起名 · Supabase 建表 SQL
-- 在 Supabase 控制台 → SQL Editor 中整段执行即可（可重复执行）
-- 表名：name_records（可用环境变量 SUPABASE_TABLE 覆盖）
-- ============================================================

-- 1) 生成 UUID 需要 pgcrypto（Supabase 默认已启用，重复执行无副作用）
create extension if not exists pgcrypto;

-- 2) 记录表：起名需求 / 生成的完整方案 / 使用的模型
create table if not exists public.name_records (
  id          uuid primary key default gen_random_uuid(),
  requirement text        not null,                -- 用户输入的起名需求
  result      text        not null,                -- AI 生成的完整方案（Markdown 原文）
  model       text        not null,                -- 使用的模型：多模型版写入「厂商/模型」，如 qwen/qwen-plus
  created_at  timestamptz not null default now()   -- 生成时间
);

comment on table  public.name_records             is 'AI 起名记录表';
comment on column public.name_records.requirement is '用户起名需求';
comment on column public.name_records.result      is 'AI 生成的起名方案（Markdown）';
comment on column public.name_records.model       is '使用的模型名称';
comment on column public.name_records.created_at  is '创建时间';

-- 3) 索引：按时间倒序查最近记录
create index if not exists name_records_created_at_idx
  on public.name_records (created_at desc);

-- 4) 行级安全
alter table public.name_records enable row level security;

-- ============================================================
-- 5) 写入权限 —— 二选一
-- ------------------------------------------------------------
-- 方案 A（推荐，最省事）：Vercel 环境变量用 service_role key
--   service_role 拥有 bypassrls，写入自动绕过 RLS，无需任何策略。
--   service_role key 只能放服务端环境变量，绝不能下发到浏览器。
--
-- 方案 B：只有 publishable / anon key（sb_publishable_...）时
--   必须显式放开一条 INSERT 策略，否则报 42501
--   「new row violates row-level security policy for table "name_records"」。
--   本系统前端不直连 Supabase（只有 /api/name 在服务端拿该 key 写入），
--   所以放开 insert 是可用且可控的；代价是拿到该 publishable key 的人
--   理论上也能往表里插数据（只会多冗余记录，不影响读取和运行）。
-- ============================================================

drop policy if exists "name_records insert via server key" on public.name_records;

create policy "name_records insert via server key"
  on public.name_records
  for insert
  to anon, authenticated
  with check (true);

-- 说明：这里只放开 INSERT，没有放开 SELECT / UPDATE / DELETE，
-- 所以即便 key 泄露，也读不到已有记录，更不能篡改或删除。

-- 可选：以后要做「历史记录」页面才需要读权限，按需放开（谨慎）：
-- drop policy if exists "name_records public read" on public.name_records;
-- create policy "name_records public read"
--   on public.name_records for select to anon using (true);

-- ============================================================
-- 6) 自检（执行后可跑一句确认表结构与策略都在）
-- ============================================================
-- select count(*) from public.name_records;
-- select policyname, cmd from pg_policies where tablename = 'name_records';
