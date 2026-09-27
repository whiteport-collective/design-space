// tool-fortnox: Fortnox API proxy for Agent Space
// POST { action, org_id, user_id, ...params }
//
// Credentials flow:
//   1. Org-level: client_id + client_secret from org_plugin_installations.config (plugin_slug: "tool_fortnox")
//   2. User-level: refresh_token from user_vault (service: "fortnox")
//   3. Access token refreshed automatically; Fortnox rotates refresh tokens on every use — new refresh_token saved back
//
// Actions: list-customers, get-customer, create-customer, create-invoice, update-invoice,
//          list-invoices, get-invoice, send-invoice, book-invoice, print-invoice,
//          list-voucher-series, get-account, create-voucher, get-voucher, account-transactions

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FORTNOX_BASE = "https://api.fortnox.se/3";
const FORTNOX_TOKEN_URL = "https://apps.fortnox.se/oauth-v1/token";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

// --- Fortnox OAuth2 token management ---

async function getAccessToken(
  supabase: ReturnType<typeof getSupabase>,
  orgId: string,
  userId: string
): Promise<string> {
  const { data: vault, error: vaultErr } = await supabase
    .from("user_vault")
    .select("id, credentials, status")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("service", "fortnox")
    .single();

  if (vaultErr || !vault) {
    throw new Error(
      `No Fortnox credentials for user ${userId} in org ${orgId}. ` +
        `Store refresh_token in user_vault with service="fortnox".`
    );
  }

  if (vault.status !== "active") {
    throw new Error(`Fortnox credentials are ${vault.status}. Please re-authorize.`);
  }

  const creds = vault.credentials as {
    refresh_token?: string;
    access_token?: string;
    token_expires_at?: number;
  };

  if (!creds.refresh_token) {
    throw new Error("No refresh token in vault.");
  }

  // Return cached token if still valid (60s buffer)
  if (
    creds.access_token &&
    creds.token_expires_at &&
    Date.now() < creds.token_expires_at - 60_000
  ) {
    await supabase
      .from("user_vault")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", vault.id);
    return creds.access_token;
  }

  // Get org-level app credentials
  const { data: installation } = await supabase
    .from("org_plugin_installations")
    .select("config")
    .eq("org_id", orgId)
    .eq("plugin_slug", "tool_fortnox")
    .single();

  const clientId = installation?.config?.fortnox_client_id;
  const clientSecret = installation?.config?.fortnox_client_secret;

  if (!clientId || !clientSecret) {
    throw new Error(
      `No Fortnox OAuth app credentials in org ${orgId}. ` +
        `Set fortnox_client_id and fortnox_client_secret in org_plugin_installations.config for tool_fortnox.`
    );
  }

  // Refresh the token — Fortnox rotates refresh tokens!
  const res = await fetch(FORTNOX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + btoa(`${clientId}:${clientSecret}`),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    await supabase
      .from("user_vault")
      .update({ status: "expired" })
      .eq("id", vault.id);
    throw new Error(`Fortnox token refresh failed: ${res.status} ${err}`);
  }

  const data = await res.json();

  // Fortnox returns a NEW refresh_token — must save it back
  const newCreds = {
    ...creds,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? creds.refresh_token,
    token_expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  };

  await supabase
    .from("user_vault")
    .update({
      credentials: newCreds,
      last_refreshed_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    })
    .eq("id", vault.id);

  return data.access_token;
}

// --- Fortnox API helpers ---

async function fortnoxGet(token: string, path: string) {
  const res = await fetch(`${FORTNOX_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fortnox GET ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

async function fortnoxPost(token: string, path: string, body: unknown) {
  const res = await fetch(`${FORTNOX_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fortnox POST ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

async function fortnoxPut(token: string, path: string, body?: unknown) {
  const res = await fetch(`${FORTNOX_BASE}${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fortnox PUT ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// --- Action handlers ---

async function listCustomers(token: string) {
  const data = await fortnoxGet(token, "/customers");
  const customers = (data.Customers || []).map((c: Record<string, unknown>) => ({
    "@url": c["@url"],
    Address1: c.Address1,
    Address2: c.Address2,
    City: c.City,
    CustomerNumber: c.CustomerNumber,
    Email: c.Email,
    Name: c.Name,
    OrganisationNumber: c.OrganisationNumber,
    Phone: c.Phone1,
    ZipCode: c.ZipCode,
  }));
  return { customers, total: customers.length };
}

async function getCustomer(token: string, customerNumber: string) {
  const data = await fortnoxGet(token, `/customers/${customerNumber}`);
  return data.Customer;
}

async function createCustomer(token: string, params: Record<string, unknown>) {
  const customer: Record<string, unknown> = { Name: params.name };
  if (params.org_number) customer.OrganisationNumber = params.org_number;
  if (params.email) customer.Email = params.email;
  if (params.city) customer.City = params.city;
  if (params.zip_code) customer.ZipCode = params.zip_code;
  if (params.address) customer.Address1 = params.address;
  if (params.phone) customer.Phone1 = params.phone;
  if (params.vat_number) customer.VATNumber = params.vat_number;

  const data = await fortnoxPost(token, "/customers", { Customer: customer });
  return data.Customer;
}

async function createInvoice(token: string, params: Record<string, unknown>) {
  const rows = (params.rows as Array<Record<string, unknown>>).map((r) => ({
    Description: r.description,
    Price: r.price,
    Quantity: r.quantity ?? 1,
    VAT: r.vat ?? 25,
    AccountNumber: r.account ?? 3001,
  }));

  const invoice: Record<string, unknown> = {
    CustomerNumber: params.customer_number,
    InvoiceRows: rows,
  };
  if (params.payment_terms) invoice.TermsOfPayment = params.payment_terms;
  if (params.our_reference) invoice.OurReference = params.our_reference;
  if (params.your_reference) invoice.YourReference = params.your_reference;
  if (params.invoice_date) invoice.InvoiceDate = params.invoice_date;

  const data = await fortnoxPost(token, "/invoices", { Invoice: invoice });
  const inv = data.Invoice;

  return {
    document_number: inv.DocumentNumber,
    customer_name: inv.CustomerName,
    net: inv.Net,
    vat: inv.TotalVAT,
    total: inv.Total,
    due_date: inv.DueDate,
    invoice_date: inv.InvoiceDate,
    payment_terms: inv.TermsOfPayment,
    status: inv.Cancelled ? "cancelled" : inv.Sent ? "sent" : inv.Booked ? "booked" : "draft",
  };
}

async function updateInvoice(token: string, params: Record<string, unknown>) {
  const body: Record<string, unknown> = {};
  if (params.rows) {
    body.InvoiceRows = (params.rows as Array<Record<string, unknown>>).map((r) => ({
      Description: r.description,
      Price: r.price,
      Quantity: r.quantity ?? 1,
      VAT: r.vat ?? 25,
      AccountNumber: r.account ?? 3001,
    }));
  }
  if (params.payment_terms) body.TermsOfPayment = params.payment_terms;
  if (params.our_reference) body.OurReference = params.our_reference;
  if (params.your_reference) body.YourReference = params.your_reference;

  const data = await fortnoxPut(
    token,
    `/invoices/${params.document_number}`,
    { Invoice: body }
  );
  return data.Invoice;
}

async function listInvoices(token: string) {
  const data = await fortnoxGet(token, "/invoices");
  const invoices = (data.Invoices || []).map((i: Record<string, unknown>) => ({
    document_number: i.DocumentNumber,
    customer_name: i.CustomerName,
    total: i.Total,
    due_date: i.DueDate,
    booked: i.Booked,
    cancelled: i.Cancelled,
    sent: i.Sent,
  }));
  return { invoices, total: invoices.length };
}

async function getInvoice(token: string, documentNumber: string) {
  const data = await fortnoxGet(token, `/invoices/${documentNumber}`);
  const inv = data.Invoice;
  return {
    document_number: inv.DocumentNumber,
    customer_name: inv.CustomerName,
    customer_number: inv.CustomerNumber,
    invoice_date: inv.InvoiceDate,
    due_date: inv.DueDate,
    net: inv.Net,
    vat: inv.TotalVAT,
    total: inv.Total,
    balance: inv.Balance,
    payment_terms: inv.TermsOfPayment,
    rows: inv.InvoiceRows,
    sent: inv.Sent,
    cancelled: inv.Cancelled,
    ocr: inv.OCR,
    email_information: inv.EmailInformation,
  };
}

async function bookInvoice(token: string, documentNumber: string) {
  const data = await fortnoxPut(token, `/invoices/${documentNumber}/bookkeep`);
  return { status: "booked", document_number: documentNumber };
}

async function sendInvoice(token: string, documentNumber: string) {
  // Fortnox API: GET /invoices/{number}/email sends the invoice by email
  const res = await fetch(`${FORTNOX_BASE}/invoices/${documentNumber}/email`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fortnox send-invoice ${documentNumber}: ${res.status} ${text}`);
  }
  return { status: "sent", document_number: documentNumber };
}

async function printInvoice(token: string, documentNumber: string) {
  const res = await fetch(`${FORTNOX_BASE}/invoices/${documentNumber}/print`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/pdf",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fortnox print-invoice ${documentNumber}: ${res.status} ${text}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
  return {
    document_number: documentNumber,
    pdf_base64: base64,
    content_type: "application/pdf",
  };
}

async function listVoucherSeries(token: string) {
  const data = await fortnoxGet(token, "/voucherseries");
  return data.VoucherSeriesCollection;
}

async function getAccount(token: string, accountNumber: string) {
  const data = await fortnoxGet(token, `/accounts/${accountNumber}`);
  return data.Account;
}

async function createVoucher(token: string, params: Record<string, unknown>) {
  const data = await fortnoxPost(token, "/vouchers", {
    Voucher: {
      Description: params.description,
      VoucherSeries: params.voucher_series ?? "A",
      TransactionDate: params.date,
      VoucherRows: params.rows,
    },
  });
  return data.Voucher;
}

async function getVoucher(token: string, series: string, number: string) {
  const data = await fortnoxGet(token, `/vouchers/${series}/${number}`);
  return data.Voucher;
}

async function accountTransactions(
  token: string,
  accountNumber: string,
  fromDate?: string,
  toDate?: string
) {
  let path = `/accounts/${accountNumber}`;
  const qs: string[] = [];
  if (fromDate) qs.push(`fromdate=${fromDate}`);
  if (toDate) qs.push(`todate=${toDate}`);
  if (qs.length) path += `?${qs.join("&")}`;
  const data = await fortnoxGet(token, path);
  return data.Account;
}

// --- Router ---

const ACTIONS: Record<string, string[]> = {
  "list-customers": [],
  "get-customer": ["customer_number"],
  "create-customer": ["name"],
  "create-invoice": ["customer_number", "rows"],
  "update-invoice": ["document_number"],
  "list-invoices": [],
  "get-invoice": ["document_number"],
  "book-invoice": ["document_number"],
  "send-invoice": ["document_number"],
  "print-invoice": ["document_number"],
  "list-voucher-series": [],
  "get-account": ["account_number"],
  "create-voucher": ["description", "rows"],
  "get-voucher": ["voucher_series", "voucher_number"],
  "account-transactions": ["account_number"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, org_id, user_id, ...params } = body;

    if (!action || !org_id || !user_id) {
      return new Response(
        JSON.stringify({ error: "Missing action, org_id, or user_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!ACTIONS[action]) {
      return new Response(
        JSON.stringify({
          error: `Unknown action: ${action}`,
          available: Object.keys(ACTIONS),
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate required params
    for (const p of ACTIONS[action]) {
      if (params[p] === undefined) {
        return new Response(
          JSON.stringify({ error: `Missing required parameter: ${p}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const supabase = getSupabase();
    const token = await getAccessToken(supabase, org_id, user_id);

    let result: unknown;

    switch (action) {
      case "list-customers":
        result = await listCustomers(token);
        break;
      case "get-customer":
        result = await getCustomer(token, params.customer_number);
        break;
      case "create-customer":
        result = await createCustomer(token, params);
        break;
      case "create-invoice":
        result = await createInvoice(token, params);
        break;
      case "update-invoice":
        result = await updateInvoice(token, params);
        break;
      case "list-invoices":
        result = await listInvoices(token);
        break;
      case "get-invoice":
        result = await getInvoice(token, params.document_number);
        break;
      case "book-invoice":
        result = await bookInvoice(token, params.document_number);
        break;
      case "send-invoice":
        result = await sendInvoice(token, params.document_number);
        break;
      case "print-invoice":
        result = await printInvoice(token, params.document_number);
        break;
      case "list-voucher-series":
        result = await listVoucherSeries(token);
        break;
      case "get-account":
        result = await getAccount(token, params.account_number);
        break;
      case "create-voucher":
        result = await createVoucher(token, params);
        break;
      case "get-voucher":
        result = await getVoucher(token, params.voucher_series, params.voucher_number);
        break;
      case "account-transactions":
        result = await accountTransactions(
          token,
          params.account_number,
          params.from_date,
          params.to_date
        );
        break;
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
