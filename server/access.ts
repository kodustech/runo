import { RunoError } from "../src/errors";

export class AccessDenied extends RunoError {}

export interface OwnedEnvironment {
  owner: string;
  instanceId: string;
  members?: string[];
}

export function canAccess(user: string, env: OwnedEnvironment): boolean {
  return env.owner === user || Boolean(env.members?.includes(user));
}

export function requireAccess<T extends OwnedEnvironment>(
  user: string, id: unknown, envs: T[], ownerOnly = false,
): T {
  const env = envs.find(e => e.instanceId === id);
  if (!env || !(ownerOnly ? env.owner === user : canAccess(user, env)))
    throw new AccessDenied("Environment access denied");
  return env;
}
