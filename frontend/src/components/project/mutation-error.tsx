

export function MutationError({ value }: { value: unknown }) {
  return value instanceof Error ? <p role="alert" className="text-sm text-danger">{value.message}</p> : null;
}
