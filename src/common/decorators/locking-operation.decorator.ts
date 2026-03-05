import { ConflictException, Logger } from '@nestjs/common';

const activeOperations = new Set<string>();
const logger = new Logger('LockingOperation');

export function LockingOperation(domainArgIndex = 0) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    descriptor.value = async function (...args: any[]) {
      const domain = args[domainArgIndex];
      if (typeof domain !== 'string') {
        throw new Error(
          `LockingOperation decorator expects a string at argument index ${domainArgIndex}, but received ${typeof domain}.`,
        );
      }
      if (activeOperations.has(domain)) {
        logger.warn(
          `[BLOCKED] Operation '${propertyKey}' on '${domain}' was blocked because another operation is active.`,
        );
        throw new ConflictException(
          `An operation is already in progress for domain '${domain}'. Please wait.`,
        );
      }
      try {
        activeOperations.add(domain);
        logger.log(`[LOCKED] Starting operation '${propertyKey}' for '${domain}'.`);
        return await originalMethod.apply(this, args);
      } finally {
        activeOperations.delete(domain);
        logger.log(`[UNLOCKED] Finished operation '${propertyKey}' for '${domain}'.`);
      }
    };
    return descriptor;
  };
}
