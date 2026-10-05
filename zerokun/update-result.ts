/** Reserved for a confirmed live-job deferral before any service cutover. */
export { UPDATE_DEFERRED_EXIT_CODE } from './update-controller.ts'

export class UpdateDeferredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpdateDeferredError'
  }
}
