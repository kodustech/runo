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

/**
 * `platformAdmin` is for lifecycle only (status/suspend/resume/destroy): the
 * platform team must be able to stop spend on anyone's machine. It is never
 * passed for exec/upload/download/tty — being admin does not open other
 * people's VMs.
 */
export function requireAccess<T extends OwnedEnvironment>(
  user: string, id: unknown, envs: T[], ownerOnly = false, platformAdmin = false,
): T {
  const env = envs.find(e => e.instanceId === id);
  if (!env || !(platformAdmin || (ownerOnly ? env.owner === user : canAccess(user, env))))
    throw new AccessDenied("Environment access denied");
  return env;
}
