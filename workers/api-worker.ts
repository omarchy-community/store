/**
 * Omarchy Store - Cloudflare Worker API
 * Handles developer applications and issue reports
 */

import { D1Database } from "@cloudflare/workers-types";

interface Env {
  DB: D1Database;
  TURNSTILE_SECRET: string;
  ADMIN_EMAIL: string;
  EMAIL_API_KEY: string;
}

interface DevApplication {
  company: string;
  name: string;
  email: string;
  website?: string;
  github?: string;
  repo_url: string;
  app_name: string;
  app_desc: string;
  app_url?: string;
  wants_paid: boolean;
  price_usd?: number;
  p_evm?: string;
  p_sol?: string;
  p_btc?: string;
  p_xrp?: string;
  agree: boolean;
  turnstile_token: string;
}

interface IssueReport {
  category: string;
  title: string;
  description: string;
  email?: string;
  app_id: string;
  turnstile_token: string;
}

const VALID_CATEGORIES = [
  'unresponsive',
  'not_working',
  'malware',
  'privacy',
  'scam',
  'broken',
  'other'
];

async function verifyTurnstile(token: string, secret: string, ip?: string): Promise<boolean> {
  const formData = new FormData();
  formData.append('secret', secret);
  formData.append('response', token);
  if (ip) formData.append('remoteip', ip);

  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: formData,
  });
  const result = await resp.json();
  return result.success === true;
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function validateGitHubUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'github.com' && u.pathname.split('/').length >= 3;
  } catch {
    return false;
  }
}

function sanitize(str: string): string {
  return str.replace(/[<>]/g, '').trim();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://omarchystore.com',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // POST /api/developers
    if (url.pathname === '/api/developers' && request.method === 'POST') {
      return handleDeveloperApplication(request, env, corsHeaders);
    }

    // POST /api/report
    if (url.pathname === '/api/report' && request.method === 'POST') {
      return handleIssueReport(request, env, corsHeaders);
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: corsHeaders,
    });
  },
};

async function handleDeveloperApplication(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = (await request.json()) as DevApplication;
    const ip = request.headers.get('CF-Connecting-IP') || '';

    // Verify Turnstile
    if (!body.turnstile_token || !(await verifyTurnstile(body.turnstile_token, env.TURNSTILE_SECRET, ip))) {
      return jsonResponse({ success: false, error: 'Turnstile verification failed' }, 400, corsHeaders);
    }

    // Validate required fields
    const errors: Record<string, string> = {};

    if (!body.company || body.company.length < 1 || body.company.length > 80) {
      errors.company = 'Company name is required (1-80 characters)';
    }
    if (!body.name || body.name.length < 1 || body.name.length > 80) {
      errors.name = 'Your name is required (1-80 characters)';
    }
    if (!body.email || !validateEmail(body.email) || body.email.length > 120) {
      errors.email = 'Valid email is required (max 120 characters)';
    }
    if (body.website && (!validateUrl(body.website) || body.website.length > 200)) {
      errors.website = 'Website must be a valid URL (max 200 characters)';
    }
    if (body.github && body.github.length > 100) {
      errors.github = 'GitHub username too long (max 100 characters)';
    }
    if (!body.repo_url || !validateGitHubUrl(body.repo_url) || body.repo_url.length > 200) {
      errors.repo_url = 'Valid GitHub repository URL is required (max 200 characters)';
    }
    if (!body.app_name || body.app_name.length < 1 || body.app_name.length > 80) {
      errors.app_name = 'App name is required (1-80 characters)';
    }
    if (!body.app_desc || body.app_desc.length < 20 || body.app_desc.length > 3000) {
      errors.app_desc = 'Description is required (20-3000 characters)';
    }
    if (body.app_url && (!validateUrl(body.app_url) || body.app_url.length > 300)) {
      errors.app_url = 'App URL must be a valid URL (max 300 characters)';
    }
    if (body.wants_paid) {
      if (!body.price_usd || body.price_usd < 0.99 || body.price_usd > 999) {
        errors.price_usd = 'Price must be between $0.99 and $999';
      }
      if (body.p_evm && (!body.p_evm.startsWith('0x') || body.p_evm.length !== 42)) {
        errors.p_evm = 'Invalid Ethereum/Base address (must be 0x... 42 chars)';
      }
      if (body.p_sol && body.p_sol.length > 44) {
        errors.p_sol = 'Invalid Solana address (max 44 chars)';
      }
      if (body.p_btc && !body.p_btc.startsWith('bc1') && body.p_btc.length > 74) {
        errors.p_btc = 'Invalid Bitcoin address (must start with bc1...)';
      }
      if (body.p_xrp && !body.p_xrp.startsWith('r') && body.p_xrp.length > 35) {
        errors.p_xrp = 'Invalid XRP address (must start with r...)';
      }
    }
    if (!body.agree) {
      errors.agree = 'You must agree to the terms';
    }

    if (Object.keys(errors).length > 0) {
      return jsonResponse({ success: false, errors }, 400, corsHeaders);
    }

    // Generate ID
    const id = `dev_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    // Sanitize inputs
    const sanitized = {
      id,
      company: sanitize(body.company),
      name: sanitize(body.name),
      email: sanitize(body.email),
      website: body.website ? sanitize(body.website) : null,
      github: body.github ? sanitize(body.github) : null,
      repo_url: sanitize(body.repo_url),
      app_name: sanitize(body.app_name),
      app_desc: sanitize(body.app_desc),
      app_url: body.app_url ? sanitize(body.app_url) : null,
      wants_paid: body.wants_paid,
      price_usd: body.price_usd || null,
      p_evm: body.p_evm ? sanitize(body.p_evm) : null,
      p_sol: body.p_sol ? sanitize(body.p_sol) : null,
      p_btc: body.p_btc ? sanitize(body.p_btc) : null,
      p_xrp: body.p_xrp ? sanitize(body.p_xrp) : null,
      status: 'pending',
      created_at: now,
    };

    // Store in D1
    await env.DB.prepare(`
      INSERT INTO developer_applications (
        id, company, name, email, website, github, repo_url,
        app_name, app_desc, app_url, wants_paid, price_usd,
        p_evm, p_sol, p_btc, p_xrp, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sanitized.id,
      sanitized.company,
      sanitized.name,
      sanitized.email,
      sanitized.website,
      sanitized.github,
      sanitized.repo_url,
      sanitized.app_name,
      sanitized.app_desc,
      sanitized.app_url,
      sanitized.wants_paid ? 1 : 0,
      sanitized.price_usd,
      sanitized.p_evm,
      sanitized.p_sol,
      sanitized.p_btc,
      sanitized.p_xrp,
      sanitized.status,
      sanitized.created_at
    ).run();

    // Send notification email (async, don't wait)
    sendAdminNotification(env, 'New Developer Application', `
      <h2>New Developer Application</h2>
      <p><strong>ID:</strong> ${id}</p>
      <p><strong>Company:</strong> ${sanitized.company}</p>
      <p><strong>Name:</strong> ${sanitized.name}</p>
      <p><strong>Email:</strong> ${sanitized.email}</p>
      <p><strong>Website:</strong> ${sanitized.website || 'N/A'}</p>
      <p><strong>GitHub:</strong> ${sanitized.github || 'N/A'}</p>
      <p><strong>Repo URL:</strong> <a href="${sanitized.repo_url}">${sanitized.repo_url}</a></p>
      <p><strong>App Name:</strong> ${sanitized.app_name}</p>
      <p><strong>Description:</strong> ${sanitized.app_desc}</p>
      <p><strong>App URL:</strong> ${sanitized.app_url || 'N/A'}</p>
      <p><strong>Paid:</strong> ${sanitized.wants_paid ? 'Yes' : 'No'}</p>
      <p><strong>Price:</strong> $${sanitized.price_usd || 'N/A'}</p>
      <p><strong>Submitted:</strong> ${now}</p>
    `).catch(console.error);

    return jsonResponse({ success: true, id, message: 'Application submitted successfully' }, 201, corsHeaders);
  } catch (e) {
    console.error('Developer application error:', e);
    return jsonResponse({ success: false, error: 'Internal server error' }, 500, corsHeaders);
  }
}

async function handleIssueReport(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = (await request.json()) as IssueReport;
    const ip = request.headers.get('CF-Connecting-IP') || '';

    // Verify Turnstile
    if (!body.turnstile_token || !(await verifyTurnstile(body.turnstile_token, env.TURNSTILE_SECRET, ip))) {
      return jsonResponse({ success: false, error: 'Turnstile verification failed' }, 400, corsHeaders);
    }

    // Validate required fields
    const errors: Record<string, string> = {};

    if (!VALID_CATEGORIES.includes(body.category)) {
      errors.category = 'Invalid category';
    }
    if (!body.title || body.title.length < 5 || body.title.length > 100) {
      errors.title = 'Title is required (5-100 characters)';
    }
    if (!body.description || body.description.length < 20 || body.description.length > 2000) {
      errors.description = 'Description is required (20-2000 characters)';
    }
    if (body.email && (!validateEmail(body.email) || body.email.length > 120)) {
      errors.email = 'Email must be valid (max 120 characters)';
    }
    if (!body.app_id || body.app_id.length < 1) {
      errors.app_id = 'App ID is required';
    }

    if (Object.keys(errors).length > 0) {
      return jsonResponse({ success: false, errors }, 400, corsHeaders);
    }

    // Generate ID
    const id = `rpt_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    // Sanitize inputs
    const sanitized = {
      id,
      category: body.category,
      title: sanitize(body.title),
      description: sanitize(body.description),
      email: body.email ? sanitize(body.email) : null,
      app_id: sanitize(body.app_id),
      status: 'open',
      created_at: now,
    };

    // Store in D1
    await env.DB.prepare(`
      INSERT INTO issue_reports (
        id, category, title, description, email, app_id, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sanitized.id,
      sanitized.category,
      sanitized.title,
      sanitized.description,
      sanitized.email,
      sanitized.app_id,
      sanitized.status,
      sanitized.created_at
    ).run();

    // Send notification email (async)
    sendAdminNotification(env, 'New Issue Report', `
      <h2>New Issue Report</h2>
      <p><strong>ID:</strong> ${id}</p>
      <p><strong>Category:</strong> ${sanitized.category}</p>
      <p><strong>Title:</strong> ${sanitized.title}</p>
      <p><strong>Description:</strong> ${sanitized.description}</p>
      <p><strong>Email:</strong> ${sanitized.email || 'Anonymous'}</p>
      <p><strong>App ID:</strong> ${sanitized.app_id}</p>
      <p><strong>Submitted:</strong> ${now}</p>
    `).catch(console.error);

    return jsonResponse({ success: true, id, message: 'Report submitted successfully' }, 201, corsHeaders);
  } catch (e) {
    console.error('Issue report error:', e);
    return jsonResponse({ success: false, error: 'Internal server error' }, 500, corsHeaders);
  }
}

async function sendAdminNotification(env: Env, subject: string, html: string): Promise<void> {
  if (!env.EMAIL_API_KEY || !env.ADMIN_EMAIL) return;

  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.EMAIL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: env.ADMIN_EMAIL }], subject }],
      from: { email: 'noreply@omarchystore.com', name: 'Omarchy Store' },
      content: [{ type: 'text/html', value: html }],
    }),
  });
}

function jsonResponse(data: any, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers });
}