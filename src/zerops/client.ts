/**
 * Read-only access to Zerops.
 *
 * The Personal Access Token works directly as a bearer token against the
 * public REST API - no exchange step is required.
 *
 * Mutations deliberately live in `cli.ts`; this module never changes state.
 */

import { config } from '../config.js';

export interface ZeropsService {
  id: string;
  name: string;
  status: string;
  typeName: string;
  category: string;
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${config.zerops.apiBase}${path}`, {
    headers: {
      Authorization: `Bearer ${config.zerops.token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(
      `Zerops API ${path} responded ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as T;
}

interface ServiceStackListResponse {
  list: Array<{
    id: string;
    name: string;
    status: string;
    serviceStackTypeInfo?: {
      serviceStackTypeName?: string;
      serviceStackTypeCategory?: string;
    };
  }>;
}

/**
 * All services in the host project.
 *
 * Zerops surfaces transient *build* containers in this list alongside real
 * services (they appear as `build<hostname>v<version>` with category BUILD).
 * They are filtered out - they are an implementation detail of the pipeline,
 * not something a user should ever see on a dashboard.
 */
export async function listServices(): Promise<ZeropsService[]> {
  const data = await apiGet<ServiceStackListResponse>(
    `/project/${config.zerops.projectId}/service-stack`,
  );

  return data.list
    .map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      typeName: item.serviceStackTypeInfo?.serviceStackTypeName ?? 'unknown',
      category: item.serviceStackTypeInfo?.serviceStackTypeCategory ?? 'USER',
    }))
    .filter((service) => service.category !== 'BUILD');
}

export interface ProbeResult {
  reachable: boolean;
  status: number | null;
  latencyMs: number;
}

/**
 * Ask the application itself whether it works.
 *
 * A service reporting ACTIVE only proves Zerops started a container. The
 * environment is not "ready" until it answers an HTTP request, so readiness is
 * defined by observed behaviour rather than by platform state.
 */
export async function probe(url: string, timeoutMs = 8_000): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Anything the app answers itself counts as alive. Zerops' own router
    // returns 502 while the container is still coming up.
    const reachable = response.status !== 502 && response.status !== 503;
    return { reachable, status: response.status, latencyMs: Date.now() - started };
  } catch {
    return { reachable: false, status: null, latencyMs: Date.now() - started };
  }
}
