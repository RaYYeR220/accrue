import { useEffect, useSyncExternalStore } from 'react'
import type { Address } from 'viem'
import { listJobs, resumePending, subscribeJobs, type LocalJob } from './jobs'

const NONE: LocalJob[] = []

// Jobs for the connected owner, kept live. Resumes once the owner is known, so a reopened app
// finds a job that was signed before it was closed, and nothing is read before the user connects.
export function useJobs(owner: Address | null): LocalJob[] {
  const jobs = useSyncExternalStore(
    subscribeJobs,
    () => (owner ? listJobs(owner) : NONE),
    () => NONE,
  )
  useEffect(() => {
    if (owner) void resumePending(owner)
  }, [owner])
  return jobs
}
