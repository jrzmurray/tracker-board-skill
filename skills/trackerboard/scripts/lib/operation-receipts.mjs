import { BoardError } from "./board.mjs";

export const MAX_OPERATION_RECEIPTS = 100;

export function validateOperation(operation) {
  if (!operation || typeof operation.id !== "string" || !/^[A-Za-z0-9_-]{16,120}$/.test(operation.id) ||
      typeof operation.hash !== "string" || !/^[a-f0-9]{64}$/.test(operation.hash)) {
    throw new BoardError("log operation receipt is invalid");
  }
}

export function findOperation(receipts, id) {
  return Array.isArray(receipts) ? receipts.find((receipt) => receipt?.id === id) || null : null;
}

export function assertOperationMatch(receipts, operation) {
  if (operation === undefined) return null;
  validateOperation(operation);
  const existing = findOperation(receipts, operation.id);
  if (existing && existing.hash !== operation.hash) throw new BoardError("log operation id was already used for different text");
  return existing;
}

export function appendOperation(receipts, operation) {
  const existing = assertOperationMatch(receipts, operation);
  if (existing) return Array.isArray(receipts) ? receipts : [];
  return [...(Array.isArray(receipts) ? receipts : []), operation].slice(-MAX_OPERATION_RECEIPTS);
}
