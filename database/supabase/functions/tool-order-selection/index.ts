import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

type OrderLike = {
  id?: string | null;
  display_id?: number | string | null;
  created_at?: string | null;
  total?: number | null;
  status?: string | null;
  email?: string | null;
  customer?: {
    id?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
  } | null;
  shipping_address?: {
    city?: string | null;
    province?: string | null;
    country_code?: string | null;
  } | null;
  billing_address?: {
    city?: string | null;
    province?: string | null;
    country_code?: string | null;
  } | null;
  region?: {
    name?: string | null;
  } | null;
  items?: Array<{
    title?: string | null;
    quantity?: number | null;
  }> | null;
  metadata?: Record<string, unknown> | null;
};

type Criterion =
  | {
      kind: "search_terms";
      label: string;
      terms: string[];
    }
  | {
      kind: "customer_query";
      label: string;
      query: string;
    }
  | {
      kind: "location_query";
      label: string;
      query: string;
    }
  | {
      kind: "product_query";
      label: string;
      query: string;
    }
  | {
      kind: "minimum_total";
      label: string;
      amount: number;
    }
  | {
      kind: "maximum_total";
      label: string;
      amount: number;
    }
  | {
      kind: "days_back";
      label: string;
      days: number;
    }
  | {
      kind: "date_range";
      label: string;
      gte?: string;
      lte?: string;
    }
  | {
      kind: "external_lookup";
      label: string;
      lookup: "vehicle_brand" | "vehicle_model" | "registration";
      query: string;
    };

type Plan = {
  title: string;
  summary: string;
  criteria: Criterion[];
};

type StepResult = {
  criterion: Criterion;
  criterion_label: string;
  criterion_type: string;
  execution_mode: string;
  status: "completed" | "empty" | "blocked";
  input_count: number;
  output_count: number;
  reasoning_summary: string;
  matched_order_ids: string[];
};

type BaseSelection = {
  run?: {
    mode?: string | null;
  } | null;
  steps?: Array<{
    step_index: number;
    criterion_label: string;
    criterion_type: string;
    execution_mode: string;
    status: string;
    input_count?: number | null;
    output_count?: number | null;
    criteria_json?: string | null;
    reasoning_summary?: string | null;
  }> | null;
} | null;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isAuthorized(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ");
}

function containsAllTerms(
  haystackParts: Array<string | null | undefined>,
  queryParts: Array<string | null | undefined>,
) {
  const haystack = haystackParts.filter(Boolean).join(" ").toLowerCase();

  const terms = queryParts
    .flatMap((part) => String(part ?? "").toLowerCase().split(/\s+/))
    .map((term) => term.trim())
    .filter(Boolean);

  if (!terms.length) {
    return true;
  }

  return terms.every((term) => haystack.includes(term));
}

function normalizeRegistration(value: string | null | undefined) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
}

function getOrderMetadataValues(order: OrderLike, keys: string[]) {
  const metadata = order.metadata && typeof order.metadata === "object" ? order.metadata : null;

  if (!metadata) {
    return [];
  }

  return keys
    .map((key) => metadata[key])
    .flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : []));
}

function getRegistrationValues(order: OrderLike) {
  return getOrderMetadataValues(order, [
    "car_registration",
    "registration",
    "registration_number",
    "registration_no",
    "license_plate",
    "plate_number",
    "regnr",
    "reg_number",
  ]);
}

function getVehicleBrandValues(order: OrderLike) {
  return getOrderMetadataValues(order, [
    "vehicle_brand",
    "vehicle_make",
    "car_brand",
    "car_make",
    "make",
    "brand",
  ]);
}

function getVehicleModelValues(order: OrderLike) {
  return getOrderMetadataValues(order, [
    "vehicle_model",
    "car_model",
    "model",
  ]);
}

function getBookingLocationValues(order: OrderLike) {
  return getOrderMetadataValues(order, [
    "booking_location",
    "booking_workshop",
    "workshop",
    "mounting_location",
  ]);
}

function classifyCapability(criterion: Criterion) {
  switch (criterion.kind) {
    case "search_terms":
    case "minimum_total":
    case "maximum_total":
    case "days_back":
    case "date_range":
      return "native";
    case "customer_query":
    case "location_query":
    case "product_query":
      return "join";
    case "external_lookup":
      return "enrichment";
  }
}

function estimateCost(criterion: Criterion) {
  switch (criterion.kind) {
    case "date_range":
    case "days_back":
      return 10;
    case "minimum_total":
    case "maximum_total":
      return 15;
    case "search_terms":
      return 20;
    case "customer_query":
      return 30;
    case "location_query":
      return 35;
    case "product_query":
      return 40;
    case "external_lookup":
      switch (criterion.lookup) {
        case "registration":
          return 90;
        case "vehicle_brand":
        case "vehicle_model":
          return 110;
      }
  }
}

function optimizePlan(plan: Plan): Plan {
  const criteria = [...plan.criteria]
    .map((criterion, index) => ({
      criterion,
      index,
      capability: classifyCapability(criterion),
      estimatedCost: estimateCost(criterion),
    }))
    .sort((left, right) => {
      if (left.estimatedCost !== right.estimatedCost) {
        return left.estimatedCost - right.estimatedCost;
      }

      if (left.capability !== right.capability) {
        return left.capability.localeCompare(right.capability);
      }

      return left.index - right.index;
    })
    .map((entry) => entry.criterion);

  return {
    title: plan.title.trim(),
    summary: criteria.map((criterion) => criterion.label.trim()).join(" -> ") || plan.summary.trim(),
    criteria,
  };
}

function isWithinDateRange(orderDate: string | undefined | null, gte?: string, lte?: string) {
  if (!orderDate) {
    return false;
  }

  const value = new Date(orderDate).getTime();
  if (Number.isNaN(value)) {
    return false;
  }

  if (gte) {
    const min = new Date(gte).getTime();
    if (Number.isNaN(min) || value < min) {
      return false;
    }
  }

  if (lte) {
    const max = new Date(lte).getTime();
    if (Number.isNaN(max) || value > max) {
      return false;
    }
  }

  return true;
}

function getOrderId(order: OrderLike, index: number) {
  return order.id ?? String(order.display_id ?? `order-${index}`);
}

function runExternalLookup(
  criterion: Extract<Criterion, { kind: "external_lookup" }>,
  orders: OrderLike[],
) {
  if (criterion.lookup === "registration") {
    const query = normalizeRegistration(criterion.query);
    const ordersWithRegistration = orders.filter((order) => getRegistrationValues(order).length > 0);

    if (!ordersWithRegistration.length) {
      return {
        status: "blocked" as const,
        reasoning_summary:
          "No registration data is available on the current candidate orders, so registration lookup cannot run.",
        matchedOrders: orders,
      };
    }

    const matchedOrders = ordersWithRegistration.filter((order) =>
      getRegistrationValues(order).some((value) => normalizeRegistration(value).includes(query))
    );

    return {
      status: matchedOrders.length ? "completed" as const : "empty" as const,
      reasoning_summary: `Matched ${matchedOrders.length} orders by registration lookup.`,
      matchedOrders,
    };
  }

  if (criterion.lookup === "vehicle_brand") {
    const ordersWithBrand = orders.filter((order) => getVehicleBrandValues(order).length > 0);

    if (!ordersWithBrand.length) {
      return {
        status: "blocked" as const,
        reasoning_summary:
          "No vehicle brand data is available on the current candidate orders, so brand enrichment cannot run yet.",
        matchedOrders: orders,
      };
    }

    const matchedOrders = ordersWithBrand.filter((order) =>
      containsAllTerms(getVehicleBrandValues(order), [criterion.query])
    );

    return {
      status: matchedOrders.length ? "completed" as const : "empty" as const,
      reasoning_summary: `Matched ${matchedOrders.length} orders by vehicle brand lookup.`,
      matchedOrders,
    };
  }

  const ordersWithModel = orders.filter((order) => getVehicleModelValues(order).length > 0);

  if (!ordersWithModel.length) {
    return {
      status: "blocked" as const,
      reasoning_summary:
        "No vehicle model data is available on the current candidate orders, so model enrichment cannot run yet.",
      matchedOrders: orders,
    };
  }

  const matchedOrders = ordersWithModel.filter((order) =>
    containsAllTerms(getVehicleModelValues(order), [criterion.query])
  );

  return {
    status: matchedOrders.length ? "completed" as const : "empty" as const,
    reasoning_summary: `Matched ${matchedOrders.length} orders by vehicle model lookup.`,
    matchedOrders,
  };
}

function matchCriterion(criterion: Criterion, orders: OrderLike[]) {
  switch (criterion.kind) {
    case "search_terms": {
      const matchedOrders = orders.filter((order) =>
        containsAllTerms(
          [
            order.display_id ? String(order.display_id) : "",
            order.email ?? "",
            order.customer?.email ?? "",
            order.customer?.first_name ?? "",
            order.customer?.last_name ?? "",
            ...getBookingLocationValues(order),
            order.shipping_address?.city ?? "",
            order.shipping_address?.province ?? "",
            order.billing_address?.city ?? "",
            order.billing_address?.province ?? "",
            order.region?.name ?? "",
            ...(order.items ?? []).map((item) => item.title ?? ""),
          ],
          criterion.terms,
        )
      );

      return {
        status: matchedOrders.length ? "completed" as const : "empty" as const,
        reasoning_summary: `Matched ${matchedOrders.length} orders by terms.`,
        matchedOrders,
      };
    }

    case "customer_query": {
      const matchedOrders = orders.filter((order) =>
        containsAllTerms(
          [order.email, order.customer?.email, order.customer?.first_name, order.customer?.last_name],
          [criterion.query],
        )
      );

      return {
        status: matchedOrders.length ? "completed" as const : "empty" as const,
        reasoning_summary: `Matched ${matchedOrders.length} orders by customer query.`,
        matchedOrders,
      };
    }

    case "location_query": {
      const matchedOrders = orders.filter((order) =>
        containsAllTerms(
          [
            ...getBookingLocationValues(order),
            order.shipping_address?.city,
            order.shipping_address?.province,
            order.shipping_address?.country_code,
            order.billing_address?.city,
            order.billing_address?.province,
            order.billing_address?.country_code,
            order.region?.name,
          ],
          [criterion.query],
        )
      );

      return {
        status: matchedOrders.length ? "completed" as const : "empty" as const,
        reasoning_summary: `Matched ${matchedOrders.length} orders by location query.`,
        matchedOrders,
      };
    }

    case "product_query": {
      const matchedOrders = orders.filter((order) =>
        containsAllTerms(
          [...(order.items ?? []).map((item) => item.title ?? "")],
          [criterion.query],
        )
      );

      return {
        status: matchedOrders.length ? "completed" as const : "empty" as const,
        reasoning_summary: `Matched ${matchedOrders.length} orders by product query.`,
        matchedOrders,
      };
    }

    case "minimum_total": {
      const matchedOrders = orders.filter((order) => (order.total ?? 0) >= criterion.amount);
      return {
        status: matchedOrders.length ? "completed" as const : "empty" as const,
        reasoning_summary: `Matched ${matchedOrders.length} orders with total >= ${criterion.amount}.`,
        matchedOrders,
      };
    }

    case "maximum_total": {
      const matchedOrders = orders.filter((order) => (order.total ?? 0) <= criterion.amount);
      return {
        status: matchedOrders.length ? "completed" as const : "empty" as const,
        reasoning_summary: `Matched ${matchedOrders.length} orders with total <= ${criterion.amount}.`,
        matchedOrders,
      };
    }

    case "days_back": {
      const now = Date.now();
      const matchedOrders = orders.filter((order) => {
        const createdAt = order.created_at ? new Date(order.created_at).getTime() : NaN;
        if (Number.isNaN(createdAt)) {
          return false;
        }

        const ageInDays = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
        return ageInDays <= criterion.days;
      });

      return {
        status: matchedOrders.length ? "completed" as const : "empty" as const,
        reasoning_summary: `Matched ${matchedOrders.length} orders from the last ${criterion.days} days.`,
        matchedOrders,
      };
    }

    case "date_range": {
      const matchedOrders = orders.filter((order) =>
        isWithinDateRange(order.created_at, criterion.gte, criterion.lte)
      );

      return {
        status: matchedOrders.length ? "completed" as const : "empty" as const,
        reasoning_summary: `Matched ${matchedOrders.length} orders in the requested date range.`,
        matchedOrders,
      };
    }

    case "external_lookup":
      return runExternalLookup(criterion, orders);
  }
}

function parseCriterionJson(criteriaJson: string | null | undefined) {
  if (!criteriaJson) {
    return null;
  }

  try {
    return JSON.parse(criteriaJson) as Criterion;
  } catch {
    return null;
  }
}

function isSameCriterion(left: Criterion | null, right: Criterion | null) {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

function withReuseSuffix(summary: string | null | undefined) {
  const base = (summary ?? "").replace(/\s*Reused from the active selection\.\s*$/i, "").trim();
  return `${base || "Reused scripted step."} Reused from the active selection.`;
}

function findReusableCompletedPrefix(plan: Plan, baseSelection: BaseSelection) {
  if (!baseSelection?.steps?.length || baseSelection?.run?.mode !== "scripted") {
    return [];
  }

  const sortedBaseSteps = [...baseSelection.steps].sort((a, b) => a.step_index - b.step_index);
  const reusableSteps: typeof sortedBaseSteps = [];

  for (let index = 0; index < plan.criteria.length && index < sortedBaseSteps.length; index += 1) {
    const step = sortedBaseSteps[index];
    const stepCriterion = parseCriterionJson(step.criteria_json);
    const targetCriterion = plan.criteria[index];

    if (!isSameCriterion(stepCriterion, targetCriterion)) {
      break;
    }

    if (step.status !== "completed") {
      break;
    }

    reusableSteps.push(step);
  }

  return reusableSteps;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!isAuthorized(req)) {
    return json({ error: "unauthorized" }, 401);
  }

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  try {
    const body = await req.json();

    if (body?.action !== "execute") {
      return json({ error: "unsupported_action" }, 400);
    }

    const plan = optimizePlan(body?.plan as Plan);
    const orders = Array.isArray(body?.orders) ? body.orders as OrderLike[] : [];
    const baseSelection = (body?.base_selection ?? null) as BaseSelection;

    if (!plan?.criteria?.length) {
      return json({ error: "plan.criteria is required" }, 400);
    }

    const steps: StepResult[] = [];
    const orderById = new Map(orders.map((order, index) => [getOrderId(order, index), order]));
    const reusablePrefix = findReusableCompletedPrefix(plan, baseSelection);
    let currentOrders = [...orders];
    let nextCriterionIndex = 0;

    if (reusablePrefix.length) {
      const lastReusableStep = reusablePrefix[reusablePrefix.length - 1];
      const matchedOrderIds = (body?.base_selection_items?.[String(lastReusableStep.step_index)] ?? []) as string[];
      if (matchedOrderIds.length) {
        currentOrders = matchedOrderIds
          .map((orderId) => orderById.get(orderId))
          .filter((order): order is OrderLike => Boolean(order));
      }

      for (const step of reusablePrefix) {
        steps.push({
          criterion: parseCriterionJson(step.criteria_json)!,
          criterion_label: step.criterion_label,
          criterion_type: step.criterion_type,
          execution_mode: step.execution_mode,
          status: "completed",
          input_count: step.input_count ?? currentOrders.length,
          output_count: step.output_count ?? currentOrders.length,
          reasoning_summary: withReuseSuffix(step.reasoning_summary),
          matched_order_ids:
            (body?.base_selection_items?.[String(step.step_index)] ?? []) as string[],
        });

        nextCriterionIndex = step.step_index;
      }
    }

    for (let index = nextCriterionIndex; index < plan.criteria.length; index += 1) {
      const criterion = plan.criteria[index];
      const result = matchCriterion(criterion, currentOrders);

      steps.push({
        criterion,
        criterion_label: criterion.label.trim(),
        criterion_type: criterion.kind === "external_lookup" ? "script_enrichment" : "script_filter",
        execution_mode: classifyCapability(criterion),
        status: result.status,
        input_count: currentOrders.length,
        output_count: result.status === "blocked" ? currentOrders.length : result.matchedOrders.length,
        reasoning_summary: result.reasoning_summary,
        matched_order_ids:
          result.status === "completed"
            ? result.matchedOrders.map((order, index) => getOrderId(order, index))
            : [],
      });

      if (result.status === "blocked" || result.matchedOrders.length === 0) {
        break;
      }

      currentOrders = result.matchedOrders;
    }

    return json({
      ok: true,
      plan,
      steps,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown order selection error";
    return json({ error: message }, 500);
  }
});
