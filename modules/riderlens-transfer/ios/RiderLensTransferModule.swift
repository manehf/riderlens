import ExpoModulesCore

struct TransferInputRecord: Record {
  @Field var attemptId: String = ""
  @Field var url: String = ""
  @Field var sourceUri: String?
  @Field var fields: [String: String] = [:]
  @Field var headers: [String: String] = [:]
}

public final class RiderLensTransferModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RiderLensTransfer")
    Events("transferChanged")
    OnCreate { [weak self] in
      RiderLensTransferCoordinator.shared.setObserver { [weak self] snapshot in
        self?.sendEvent("transferChanged", snapshot)
      }
    }
    AsyncFunction("ensureUpload") { (input: TransferInputRecord, promise: Promise) in
      RiderLensTransferCoordinator.shared.ensureUpload(
        TransferInput(attemptId: input.attemptId, url: input.url, sourceUri: input.sourceUri,
                      fields: input.fields, headers: input.headers), completion: { result in
          Self.settle(result, promise)
        })
    }
    AsyncFunction("reconcile") { (promise: Promise) in
      RiderLensTransferCoordinator.shared.reconcile { Self.settle($0, promise) }
    }
    AsyncFunction("cancel") { (transferId: String, promise: Promise) in
      RiderLensTransferCoordinator.shared.cancel(transferId) { Self.settle($0, promise) }
    }
    AsyncFunction("resume") { (transferId: String, promise: Promise) in
      RiderLensTransferCoordinator.shared.resume(transferId) { Self.settle($0, promise) }
    }
    AsyncFunction("acknowledge") { (transferId: String, promise: Promise) in
      RiderLensTransferCoordinator.shared.acknowledge(transferId) { Self.settle($0, promise) }
    }
  }

  private static func settle<T>(_ result: Result<T, Error>, _ promise: Promise) {
    switch result {
    case .success(let value):
      if value is Void { promise.resolve() } else { promise.resolve(value) }
    case .failure(let error):
      let failure = error as NSError
      promise.reject(failure.domain, failure.localizedDescription)
    }
  }
}
