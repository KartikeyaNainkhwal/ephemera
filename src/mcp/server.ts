/**
 * Ephemera MCP server.
 *
 * Gives a coding agent the ability to ask for a real, disposable environment
 * mid-task - a running application with its own PostgreSQL database and a
 * public URL - and to destroy it when finished.
 *
 * The distinction from a conventional agent sandbox is that nothing here is
 * simulated. The agent gets the same managed PostgreSQL, the same private
 * network and the same deploy pipeline that production uses. What makes it
 * safe to hand out freely is that it is disposable and it expires on its own.
 *
 * Runs over stdio and talks to a deployed Ephemera control plane over HTTP,
 * so the agent needs no Zerops credentials of its own.
 *
 *   {
 *     "mcpServers": {
 *       "ephemera": {
 *         "command": "node",
 *         "args": ["/path/to/ephemera/dist/mcp/server.js"],
 *         "env": {
 *           "EPHEMERA_URL": "https://<your-control-plane>",
 *           "EPHEMERA_API_KEY": "<admin key - required for create/destroy>"
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = (process.env.EPHEMERA_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = process.env.EPHEMERA_API_KEY?.trim() ?? '';

interface EnvironmentPayload {
  id: string;
  slug: string;
  url: string;
  status: string;
  error: string | null;
  provisioningSeconds: number | null;
  services: { app: string; database: string | null };
  cost: { hourly: number; accrued: number };
  expiresAt: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Ephemera responded ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

function describe(environment: EnvironmentPayload): string {
  const lines = [
    `slug:     ${environment.slug}`,
    `status:   ${environment.status}`,
    `url:      ${environment.url}`,
    `services: ${environment.services.app}` +
      (environment.services.database ? ` + ${environment.services.database} (PostgreSQL)` : ''),
    `expires:  ${environment.expiresAt}`,
    `cost:     $${environment.cost.hourly.toFixed(4)}/hour`,
  ];
  if (environment.provisioningSeconds !== null) {
    lines.push(`ready in: ${environment.provisioningSeconds}s`);
  }
  if (environment.error) lines.push(`error:    ${environment.error}`);
  return lines.join('\n');
}

const server = new McpServer({ name: 'ephemera', version: '1.0.0' });

server.tool(
  'create_environment',
  'Provision a disposable, fully isolated environment on Zerops from a public git ' +
    'repository: a running application container plus its own dedicated PostgreSQL ' +
    'database, reachable at a public URL. Returns immediately with the final URL; ' +
    'the environment is usually serving traffic within two minutes. Poll ' +
    'get_environment until status is "ready" before making requests against it.',
  {
    slug: z
      .string()
      .describe(
        'Short name for this environment, lowercase letters and digits only, ' +
          'e.g. "migrationtest". Must be unique among live environments.',
      ),
    repo: z.string().describe('Public git repository URL to build from.'),
    branch: z.string().optional().describe('Branch or ref. Defaults to the repository default.'),
    runtime: z
      .string()
      .optional()
      .describe('Zerops runtime type, e.g. "nodejs@22", "python@3.12", "go@1.22".'),
    port: z.number().optional().describe('Port the application listens on. Defaults to 3000.'),
    buildCommands: z.array(z.string()).optional().describe('Build commands.'),
    startCommand: z.string().optional().describe('Command that starts the application.'),
    deployFiles: z.array(z.string()).optional().describe('Paths to include in the artifact.'),
    withDatabase: z
      .boolean()
      .optional()
      .describe('Provision a dedicated PostgreSQL service. Defaults to true.'),
    ttlMinutes: z
      .number()
      .optional()
      .describe('Minutes before automatic destruction. Defaults to 120.'),
  },
  async (args) => {
    const environment = await call<EnvironmentPayload>('/api/environments', {
      method: 'POST',
      body: JSON.stringify({ ...args, source: 'agent' }),
    });
    return {
      content: [
        {
          type: 'text',
          text:
            `Environment requested.\n\n${describe(environment)}\n\n` +
            `It is not serving traffic yet. Poll get_environment with id ` +
            `${environment.id} until status is "ready".`,
        },
      ],
    };
  },
);

server.tool(
  'get_environment',
  'Read the current state of an environment, including whether it is serving traffic.',
  { id: z.string().describe('Environment id returned by create_environment.') },
  async ({ id }) => {
    const environment = await call<EnvironmentPayload>(`/api/environments/${id}`);
    return { content: [{ type: 'text', text: describe(environment) }] };
  },
);

server.tool(
  'list_environments',
  'List every environment that has not been destroyed.',
  {},
  async () => {
    const { environments } = await call<{ environments: EnvironmentPayload[] }>(
      '/api/environments',
    );
    if (environments.length === 0) {
      return { content: [{ type: 'text', text: 'No live environments.' }] };
    }
    return {
      content: [
        {
          type: 'text',
          text: environments
            .map((e) => `${e.slug} [${e.status}] ${e.url} (id ${e.id})`)
            .join('\n'),
        },
      ],
    };
  },
);

server.tool(
  'destroy_environment',
  'Destroy an environment and its database immediately, stopping all billing. ' +
    'Environments also expire on their own, so this is an optimisation rather ' +
    'than a requirement.',
  { id: z.string().describe('Environment id to destroy.') },
  async ({ id }) => {
    const environment = await call<EnvironmentPayload>(`/api/environments/${id}`, {
      method: 'DELETE',
    });
    return {
      content: [
        {
          type: 'text',
          text:
            `Destroyed ${environment.slug}. Total cost ` +
            `$${environment.cost.accrued.toFixed(5)}.`,
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
