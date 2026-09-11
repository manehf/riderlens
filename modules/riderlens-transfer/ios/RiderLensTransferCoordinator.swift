import Foundation
import UIKit

/// Owns the background session even when no Expo module / JavaScript runtime exists.
/// All mutable state and URLSession delegate callbacks use `queue`.
public final class RiderLensTransferCoordinator: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
  public static let shared = RiderLensTransferCoordinator()
  public static var sessionIdentifier: String {
    "\(Bundle.main.bundleIdentifier ?? "com.riderlens.unknown").riderlens.analysis-transfer.v1"
  }
  public static func ownsSession(_ identifier: String) -> Bool { identifier == sessionIdentifier }

  private let queue = DispatchQueue(label: "com.riderlens.transfer.state")
  private let preparationQueue = DispatchQueue(label: "com.riderlens.transfer.prepare", qos: .utility)
  private var journal: TransferJournal?
  private var entries: [String: TransferEntry] = [:]
  private var tasks: [String: URLSessionTask] = [:]
  private var preparations: [String: PreparationControl] = [:]
  private var responseData: [String: Data] = [:]
  private var responseErrors: [String: NSError] = [:]
  private var dirtyReceipts = Set<String>()
  private var observer: (([String: Any]) -> Void)?
  private var session: URLSession?
  private var backgroundHandlers: [() -> Void] = []
  private var backgroundEventsFinished = false
  // A preparation can create a task while getAllTasks is crossing its async
  // boundary. Discard stale enumerations instead of declaring that task missing.
  private var taskGeneration: UInt64 = 0
  private let maxResponseBytes = 256 * 1024

  private override init() { super.init() }

  public func handleBackgroundEvents(completionHandler: @escaping () -> Void) {
    queue.async {
      self.backgroundHandlers.append(completionHandler)
      self.backgroundEventsFinished = false
      do {
        try self.initialize()
        self.enumerate { _ in self.finishBackgroundEventsIfSafe() }
      } catch {
        // Never acknowledge the OS before receipts are durable. A later foreground
        // reconcile retries unavailable protected storage / disk writes.
      }
    }
  }

  func setObserver(_ callback: @escaping ([String: Any]) -> Void) {
    queue.async { self.observer = callback }
  }

  private func initialize() throws {
    if journal == nil {
      let store = try TransferJournal()
      let loaded = try store.load() // Fail closed on a corrupt/unreadable journal.
      journal = store
      entries = loaded
    }
    if session == nil {
      let configuration = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
      configuration.isDiscretionary = false
      configuration.sessionSendsLaunchEvents = true
      configuration.waitsForConnectivity = true
      configuration.timeoutIntervalForRequest = 120
      configuration.timeoutIntervalForResource = 30 * 60
      configuration.httpMaximumConnectionsPerHost = 1
      configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
      configuration.urlCache = nil
      let delegateQueue = OperationQueue()
      delegateQueue.maxConcurrentOperationCount = 1
      delegateQueue.underlyingQueue = queue
      session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }
  }

  private func notify(_ snapshot: TransferSnapshot) {
    guard let observer = observer else { return }
    let value = snapshot.dictionary()
    DispatchQueue.main.async { observer(value) }
  }

  private func persist(_ entry: TransferEntry) throws {
    guard let journal = journal else { throw transferError("E_TRANSFER_JOURNAL", "Transfer storage is unavailable.") }
    try journal.save(entry)
    entries[entry.snapshot.transferId] = entry
  }

  private func flushReceipts() throws {
    for id in Array(dirtyReceipts) {
      guard let entry = entries[id] else { continue }
      try journal?.save(entry)
      dirtyReceipts.remove(id)
      try? journal?.removeBody(id)
      notify(entry.snapshot)
    }
    finishBackgroundEventsIfSafe()
  }

  private func terminal(_ id: String, error: NSError? = nil, task: URLSessionTask? = nil) {
    guard var entry = entries[id] else { return }
    entry.snapshot.state = "terminal"
    entry.snapshot.completedAt = Date().timeIntervalSince1970 * 1000
    if let task = task {
      entry.snapshot.bytesSent = task.countOfBytesSent
      entry.snapshot.bytesExpected = max(0, task.countOfBytesExpectedToSend)
      if let response = task.response as? HTTPURLResponse {
        entry.snapshot.status = response.statusCode
        entry.snapshot.retryAfter = response.value(forHTTPHeaderField: "Retry-After")
      }
    }
    if let data = responseData.removeValue(forKey: id) {
      entry.snapshot.body = String(decoding: data, as: UTF8.self)
    }
    let failure = responseErrors.removeValue(forKey: id) ?? error
    entry.snapshot.errorDomain = failure?.domain
    entry.snapshot.errorCode = failure?.code
    entry.snapshot.errorMessage = failure?.localizedDescription
    entries[id] = entry
    tasks.removeValue(forKey: id)
    taskGeneration &+= 1
    dirtyReceipts.insert(id)
    // If persistence fails, do not publish a volatile receipt or delete its body.
    // All public reads/admissions retry this write and reject until it succeeds.
    try? flushReceipts()
  }

  private func id(for task: URLSessionTask) -> String? {
    guard let id = task.taskDescription, UUID(uuidString: id) != nil else { return nil }
    return id
  }

  /// Enumeration is mandatory before admission and orphan cleanup. URLSession is
  /// authoritative in the crash window before the task association was journaled.
  private func enumerate(_ completion: @escaping (Result<Void, Error>) -> Void) {
    do { try initialize(); try flushReceipts() } catch { completion(.failure(error)); return }
    let generation = taskGeneration
    session!.getAllTasks { actual in
      self.queue.async {
        guard generation == self.taskGeneration else {
          self.enumerate(completion)
          return
        }
        do {
          var live: [String: URLSessionTask] = [:]
          for task in actual {
            let id = self.id(for: task) ?? UUID().uuidString
            // Let an already-enqueued completion delegate preserve the actual
            // response before fabricating an uncertain outcome. Terminal entries
            // already have that receipt and need no completed-task barrier.
            if task.state == .completed {
              if let entry = self.entries[id], entry.snapshot.state != "terminal" { live[id] = task }
              continue
            }
            if self.entries[id] == nil {
              let orphan = TransferEntry(snapshot: TransferSnapshot(attemptId: "orphan-\(id)",
                transferId: id, state: "cancelling", createdAt: Date().timeIntervalSince1970 * 1000),
                input: nil, fingerprint: "", boundary: "", taskIdentifier: task.taskIdentifier)
              try self.persist(orphan)
              task.taskDescription = id
              task.cancel()
            }
            // A second task with the same metadata must not displace the first.
            if live[id] != nil {
              let orphanId = UUID().uuidString
              let orphan = TransferEntry(snapshot: TransferSnapshot(attemptId: "orphan-\(orphanId)",
                transferId: orphanId, state: "cancelling", createdAt: Date().timeIntervalSince1970 * 1000),
                input: nil, fingerprint: "", boundary: "", taskIdentifier: task.taskIdentifier)
              try self.persist(orphan)
              task.taskDescription = orphanId
              live[orphanId] = task
              task.cancel()
              continue
            }
            live[id] = task
            var entry = self.entries[id]!
            if entry.snapshot.state == "terminal" || entry.snapshot.state == "cancelling" {
              task.cancel()
            } else {
              // Discovery does not authorize old/deleted work to start. A task
              // created before the association crash window remains suspended
              // until the app has checked record ownership and calls resume().
              entry.snapshot.state = task.state == .suspended ? "preparing" : "running"
              entry.taskIdentifier = task.taskIdentifier
              entry.snapshot.bytesSent = task.countOfBytesSent
              entry.snapshot.bytesExpected = max(0, task.countOfBytesExpectedToSend)
              try self.persist(entry)
            }
          }
          self.tasks = live
          for (id, entry) in self.entries where live[id] == nil && self.preparations[id] == nil {
            switch entry.snapshot.state {
            case "running":
              self.terminal(id, error: transferError("E_TRANSFER_OUTCOME_UNKNOWN", "The upload outcome is unknown. Check the analysis before sending again."))
            case "cancelling":
              self.terminal(id, error: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
            case "terminal":
              try? self.journal?.removeBody(id)
            default: break
            }
          }
          try self.flushReceipts()
          try self.journal?.sweepUnknownFolders(keeping: Set(self.entries.keys).union(live.keys))
          completion(.success(()))
        } catch { completion(.failure(error)) }
      }
    }
  }

  func ensureUpload(_ input: TransferInput, completion: @escaping (Result<[String: Any], Error>) -> Void) {
    queue.async {
      do {
        let fingerprint = try input.validatedFingerprint()
        self.enumerate { result in
          do {
            try result.get()
            if let existing = self.entries.values.first(where: { $0.snapshot.attemptId == input.attemptId }) {
              guard existing.fingerprint == fingerprint else {
                throw transferError("E_TRANSFER_CONFLICT", "This attempt already belongs to different upload input.")
              }
              // Discovery/duplicate ensure never restarts stale preparation.
              // The app explicitly resumes after checking current ownership.
              completion(.success(existing.snapshot.dictionary()))
              return
            }
            guard !self.entries.values.contains(where: { $0.snapshot.state != "terminal" }), self.tasks.isEmpty else {
              throw transferError("E_TRANSFER_BUSY", "Another analysis upload is still active.")
            }
            // Foreground eligibility must be read on the main thread, and the
            // admission guard repeated on our queue after this async boundary.
            DispatchQueue.main.async {
              let active = UIApplication.shared.applicationState == .active
              self.queue.async {
                do {
                  guard active else { throw transferError("E_TRANSFER_BACKGROUND", "Upload admission waits until the app is active.") }
                  if let existing = self.entries.values.first(where: { $0.snapshot.attemptId == input.attemptId }) {
                    guard existing.fingerprint == fingerprint else {
                      throw transferError("E_TRANSFER_CONFLICT", "This attempt already belongs to different upload input.")
                    }
                    completion(.success(existing.snapshot.dictionary()))
                    return
                  }
                  guard !self.entries.values.contains(where: { $0.snapshot.state != "terminal" || $0.snapshot.attemptId == input.attemptId }), self.tasks.isEmpty else {
                    throw transferError("E_TRANSFER_BUSY", "Another analysis upload was admitted first.")
                  }
                  let id = UUID().uuidString
                  let entry = TransferEntry(snapshot: TransferSnapshot(attemptId: input.attemptId, transferId: id,
                    state: "preparing", createdAt: Date().timeIntervalSince1970 * 1000), input: input,
                    fingerprint: fingerprint, boundary: "RiderLens-\(id)", taskIdentifier: nil)
                  try self.persist(entry) // Durable intent exists before any file or native task.
                  self.startPreparation(id)
                  completion(.success(entry.snapshot.dictionary()))
                } catch { completion(.failure(error)) }
              }
            }
          } catch { completion(.failure(error)) }
        }
      } catch { completion(.failure(error)) }
    }
  }

  func reconcile(completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
    queue.async {
      self.enumerate { result in
        do {
          try result.get()
          let values = self.entries.values.sorted { $0.snapshot.createdAt < $1.snapshot.createdAt }
          completion(.success(values.map { $0.snapshot.dictionary() }))
        } catch { completion(.failure(error)) }
      }
    }
  }

  /// The app must validate current record ownership before calling this method.
  /// Reconcile is intentionally observation-only for stopped preparation/tasks.
  func resume(_ id: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
    queue.async {
      self.enumerate { result in
        do {
          try result.get()
          guard self.entries[id] != nil else { throw transferError("E_TRANSFER_NOT_FOUND", "Transfer not found.") }
          DispatchQueue.main.async {
            let active = UIApplication.shared.applicationState == .active
            self.queue.async {
              do {
                guard active else { throw transferError("E_TRANSFER_BACKGROUND", "Upload preparation waits until the app is active.") }
                try self.resumeOwned(id)
                guard let entry = self.entries[id] else { throw transferError("E_TRANSFER_NOT_FOUND", "Transfer not found.") }
                completion(.success(entry.snapshot.dictionary()))
              } catch { completion(.failure(error)) }
            }
          }
        } catch { completion(.failure(error)) }
      }
    }
  }

  private func resumeOwned(_ id: String) throws {
    guard var entry = entries[id], entry.snapshot.state == "preparing" else { return }
    if let task = tasks[id] {
      guard task.state == .suspended else { return }
      entry.snapshot.state = "running"
      try persist(entry)
      task.resume()
      taskGeneration &+= 1
      notify(entry.snapshot)
    } else { startPreparation(id) }
  }

  func cancel(_ id: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
    queue.async {
      self.enumerate { result in
        do {
          try result.get()
          guard var entry = self.entries[id] else { throw transferError("E_TRANSFER_NOT_FOUND", "Transfer not found.") }
          if entry.snapshot.state != "terminal" {
            entry.snapshot.state = "cancelling"
            try self.persist(entry)
            if let preparation = self.preparations[id] { preparation.stop() }
            else if let task = self.tasks[id] { task.cancel() }
            else { self.terminal(id, error: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)) }
          }
          try self.flushReceipts()
          completion(.success(self.entries[id]!.snapshot.dictionary()))
        } catch { completion(.failure(error)) }
      }
    }
  }

  func acknowledge(_ id: String, completion: @escaping (Result<Void, Error>) -> Void) {
    queue.async {
      self.enumerate { result in
        do {
          try result.get()
          guard let entry = self.entries[id] else { completion(.success(())); return }
          guard entry.snapshot.state == "terminal", self.tasks[id] == nil, self.preparations[id] == nil else {
            throw transferError("E_TRANSFER_NOT_TERMINAL", "Wait for transfer cancellation or completion before acknowledging it.")
          }
          try self.journal?.remove(id)
          self.entries.removeValue(forKey: id)
          completion(.success(()))
        } catch { completion(.failure(error)) }
      }
    }
  }

  private func startPreparation(_ id: String) {
    guard let entry = entries[id], entry.snapshot.state == "preparing", preparations.isEmpty,
          tasks.isEmpty, let journal = journal else { return }
    let control = PreparationControl()
    preparations[id] = control // Reserve before dispatching to the main queue.
    DispatchQueue.main.async {
      guard UIApplication.shared.applicationState == .active else {
        self.queue.async {
          self.preparations.removeValue(forKey: id)
          if self.entries[id]?.snapshot.state == "cancelling" {
            self.terminal(id, error: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
          }
        }
        return
      }
      // Both accesses to this identifier run on main. Expiration ends the OS
      // allowance immediately; the copy queue observes the stop at its next chunk.
      var allowance: UIBackgroundTaskIdentifier = .invalid
      allowance = UIApplication.shared.beginBackgroundTask(withName: "Prepare analysis upload") {
        control.stop()
        if allowance != .invalid {
          UIApplication.shared.endBackgroundTask(allowance)
          allowance = .invalid
        }
      }
      self.preparationQueue.async {
        let result = Result { try prepareMultipart(entry, journal: journal, control: control) }
        self.queue.async {
          self.preparations.removeValue(forKey: id)
          defer {
            DispatchQueue.main.async {
              if allowance != .invalid {
                UIApplication.shared.endBackgroundTask(allowance)
                allowance = .invalid
              }
            }
          }
          guard var current = self.entries[id] else { return }
          if current.snapshot.state == "cancelling" {
            self.terminal(id, error: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
            return
          }
          do {
            current.snapshot.bytesExpected = try result.get()
            try control.check()
            guard let input = current.input, let url = URL(string: input.url) else {
              throw transferError("E_TRANSFER_INPUT", "Missing upload input.")
            }
            var request = URLRequest(url: url, timeoutInterval: 120)
            request.httpMethod = "POST"
            for (key, value) in input.headers { request.setValue(value, forHTTPHeaderField: key) }
            request.setValue("multipart/form-data; boundary=\(current.boundary)", forHTTPHeaderField: "Content-Type")
            request.setValue(String(current.snapshot.bytesExpected), forHTTPHeaderField: "Content-Length")
            let task = self.session!.uploadTask(with: request, fromFile: journal.body(id))
            task.taskDescription = id
            self.tasks[id] = task // A suspended task counts as active for admission.
            self.taskGeneration &+= 1
            current.taskIdentifier = task.taskIdentifier
            current.snapshot.state = "running"
            do { try self.persist(current) } catch {
              // The intent + taskDescription let enumeration recover this task.
              // Do not resume if its durable association write failed.
              task.cancel()
              self.responseErrors[id] = transferError("E_TRANSFER_JOURNAL", "Could not save the upload task association.")
              return
            }
            task.resume()
            self.notify(current.snapshot)
          } catch {
            if (error as NSError).domain == "E_PREPARATION_PAUSED" {
              // Intent is the checkpoint. Restart the bounded-memory copy on the
              // next foreground reconcile; no URLSession upload exists yet.
              try? journal.removeBody(id)
              self.notify(current.snapshot)
            } else { self.terminal(id, error: error as NSError) }
          }
        }
      }
    }
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                         totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
    guard let id = id(for: task), var entry = entries[id], entry.snapshot.state != "terminal" else { return }
    entry.snapshot.bytesSent = totalBytesSent
    entry.snapshot.bytesExpected = max(0, totalBytesExpectedToSend)
    entries[id] = entry // Progress is recovered from URLSession; do not fsync per chunk.
    notify(entry.snapshot)
  }

  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let id = id(for: dataTask), entries[id] != nil, responseErrors[id] == nil else { return }
    var accumulated = responseData[id] ?? Data()
    guard accumulated.count + data.count <= maxResponseBytes else {
      responseErrors[id] = transferError("E_TRANSFER_RESPONSE_TOO_LARGE", "Upload acknowledgement exceeded the response limit. Check analysis status.")
      dataTask.cancel()
      return
    }
    accumulated.append(data)
    responseData[id] = accumulated
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let id = id(for: task), entries[id] != nil else { return }
    terminal(id, error: error.map { $0 as NSError }, task: task)
  }

  public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    backgroundEventsFinished = true
    try? flushReceipts()
    finishBackgroundEventsIfSafe()
  }

  private func finishBackgroundEventsIfSafe() {
    guard backgroundEventsFinished, dirtyReceipts.isEmpty, !backgroundHandlers.isEmpty else { return }
    let handlers = backgroundHandlers
    backgroundHandlers.removeAll()
    DispatchQueue.main.async { handlers.forEach { $0() } }
  }
}
