import Foundation
import CryptoKit
import Darwin

struct TransferInput: Codable {
  let attemptId: String
  let url: String
  let sourceUri: String?
  let fields: [String: String]
  let headers: [String: String]

  func validatedFingerprint() throws -> String {
    guard !attemptId.isEmpty, attemptId.count <= 200,
          let endpoint = URL(string: url), endpoint.scheme == "https", endpoint.host != nil,
          fields["request_id"] == attemptId,
          sourceUri != nil || fields["upload_id"] != nil else {
      throw transferError("E_TRANSFER_INPUT", "Invalid analysis transfer input.")
    }
    if let sourceUri = sourceUri {
      guard let source = URL(string: sourceUri), source.isFileURL else {
        throw transferError("E_TRANSFER_INPUT", "The source must be a local file.")
      }
    }
    guard fields.keys.allSatisfy({ !$0.isEmpty && !$0.contains(where: { "\r\n\"".contains($0) }) }),
          headers.allSatisfy({ !$0.key.contains(where: { "\r\n".contains($0) }) && !$0.value.contains(where: { "\r\n".contains($0) }) }) else {
      throw transferError("E_TRANSFER_INPUT", "Invalid multipart field or header.")
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return SHA256.hash(data: try encoder.encode(self)).map { String(format: "%02x", $0) }.joined()
  }
}

struct TransferSnapshot: Codable {
  let attemptId: String
  let transferId: String
  var state: String
  var bytesSent: Int64 = 0
  var bytesExpected: Int64 = 0
  let createdAt: Double
  var completedAt: Double?
  var status: Int?
  var body: String?
  var retryAfter: String?
  var errorDomain: String?
  var errorCode: Int?
  var errorMessage: String?

  func dictionary() -> [String: Any] {
    var value: [String: Any] = ["attemptId": attemptId, "transferId": transferId,
      "state": state, "bytesSent": bytesSent, "bytesExpected": bytesExpected, "createdAt": createdAt]
    value["completedAt"] = completedAt
    value["status"] = status
    value["body"] = body
    value["retryAfter"] = retryAfter
    value["errorDomain"] = errorDomain
    value["errorCode"] = errorCode
    value["errorMessage"] = errorMessage
    return value
  }
}

struct TransferEntry: Codable {
  var snapshot: TransferSnapshot
  let input: TransferInput?
  let fingerprint: String
  let boundary: String
  var taskIdentifier: Int?
}

func transferError(_ code: String, _ message: String) -> NSError {
  NSError(domain: code, code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

final class TransferJournal {
  let root: URL
  private let manager = FileManager.default

  init(rootURL: URL? = nil) throws {
    if let rootURL = rootURL { root = rootURL }
    else {
      let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                    appropriateFor: nil, create: true)
      root = support.appendingPathComponent("RiderLensTransfer", isDirectory: true)
    }
    try Self.createProtectedDirectory(root)
  }

  static func createProtectedDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var resource = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try resource.setResourceValues(values)
  }

  func directory(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }
  func body(_ id: String) -> URL { directory(id).appendingPathComponent("body.multipart") }
  func partial(_ id: String) -> URL { directory(id).appendingPathComponent("body.partial") }

  func load() throws -> [String: TransferEntry] {
    var records: [String: TransferEntry] = [:]
    for directory in try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
      guard UUID(uuidString: directory.lastPathComponent) != nil else { continue }
      let file = directory.appendingPathComponent("journal.json")
      // A directory without a committed intent can only be a pre-admission crash.
      guard manager.fileExists(atPath: file.path) else { continue }
      let entry = try JSONDecoder().decode(TransferEntry.self, from: Data(contentsOf: file))
      guard entry.snapshot.transferId == directory.lastPathComponent else {
        throw transferError("E_TRANSFER_JOURNAL", "Transfer journal identity mismatch.")
      }
      records[entry.snapshot.transferId] = entry
    }
    return records
  }

  func save(_ entry: TransferEntry) throws {
    let folder = directory(entry.snapshot.transferId)
    try Self.createProtectedDirectory(folder)
    let file = folder.appendingPathComponent("journal.json")
    let temporary = folder.appendingPathComponent("journal.pending")
    let data = try JSONEncoder().encode(entry)
    try Self.writeProtected(data, to: temporary)
    try Self.commit(temporary, to: file)
  }

  static func writeProtected(_ data: Data, to url: URL) throws {
    guard FileManager.default.createFile(atPath: url.path, contents: nil,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else {
      throw transferError("E_TRANSFER_DISK", "Could not create transfer file.")
    }
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.write(contentsOf: data)
    try handle.synchronize()
  }

  static func commit(_ temporary: URL, to destination: URL) throws {
    let result = temporary.path.withCString { source in
      destination.path.withCString { target in Darwin.rename(source, target) }
    }
    guard result == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    let fd = Darwin.open(destination.deletingLastPathComponent().path, O_RDONLY)
    guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    defer { Darwin.close(fd) }
    guard fsync(fd) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
  }

  func removeBody(_ id: String) throws {
    for file in [body(id), partial(id)] where manager.fileExists(atPath: file.path) {
      try manager.removeItem(at: file)
    }
  }

  func remove(_ id: String) throws { try manager.removeItem(at: directory(id)) }

  // Called only after URLSession enumeration. Never sweep task-owned folders.
  func sweepUnknownFolders(keeping ids: Set<String>) throws {
    for folder in try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
      guard UUID(uuidString: folder.lastPathComponent) != nil,
            !ids.contains(folder.lastPathComponent) else { continue }
      try manager.removeItem(at: folder)
    }
  }
}

/// This flag is the only state shared with the file-copy queue.
final class PreparationControl {
  private let lock = NSLock()
  private var stopped = false
  func stop() { lock.lock(); stopped = true; lock.unlock() }
  func check() throws {
    lock.lock(); let value = stopped; lock.unlock()
    if value { throw transferError("E_PREPARATION_PAUSED", "Transfer preparation was interrupted.") }
  }
}

func prepareMultipart(_ entry: TransferEntry, journal: TransferJournal, control: PreparationControl) throws -> Int64 {
  guard let input = entry.input else { throw transferError("E_TRANSFER_INPUT", "Missing transfer input.") }
  var sourceSize: Int64 = 0
  if let uri = input.sourceUri, let source = URL(string: uri) {
    let values = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    guard values.isRegularFile == true else { throw transferError("E_TRANSFER_INPUT", "The upload source must be a regular file.") }
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: source.path)
    sourceSize = Int64(values.fileSize ?? 0)
  }
  let metadataSize = input.fields.reduce(Int64(8192)) { $0 + Int64($1.key.utf8.count + $1.value.utf8.count + 1024) }
  // Preflight improves the error before copying. Checked writes remain required:
  // another process can consume this space while preparation is in progress.
  let capacities = try? journal.root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeAvailableCapacityKey])
  // Some filesystems report zero for important-usage capacity although ordinary
  // free space is available. Use actual free bytes as a conservative fallback.
  let available = capacities.map { max($0.volumeAvailableCapacityForImportantUsage ?? 0, Int64($0.volumeAvailableCapacity ?? 0)) }
  if let available = available, available < sourceSize + metadataSize + 1024 * 1024 {
    throw NSError(domain: NSCocoaErrorDomain, code: NSFileWriteOutOfSpaceError,
                  userInfo: [NSLocalizedDescriptionKey: "Not enough space to prepare the upload. The original video is retained."])
  }
  let partial = journal.partial(entry.snapshot.transferId)
  try? FileManager.default.removeItem(at: partial)
  var committed = false
  defer { if !committed { try? FileManager.default.removeItem(at: partial) } }
  try TransferJournal.writeProtected(Data(), to: partial)
  let output = try FileHandle(forWritingTo: partial)
  defer { try? output.close() }
  var length: Int64 = 0
  func append(_ data: Data) throws {
    try control.check()
    try output.write(contentsOf: data)
    length += Int64(data.count)
  }
  for name in input.fields.keys.sorted() {
    try append(Data("--\(entry.boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(input.fields[name]!)\r\n".utf8))
  }
  if let uri = input.sourceUri, let source = URL(string: uri) {
    let isMov = source.pathExtension.lowercased() == "mov"
    let name = isMov ? "clip.mov" : "clip.mp4"
    let type = isMov ? "video/quicktime" : "video/mp4"
    try append(Data("--\(entry.boundary)\r\nContent-Disposition: form-data; name=\"video\"; filename=\"\(name)\"\r\nContent-Type: \(type)\r\n\r\n".utf8))
    let reader = try FileHandle(forReadingFrom: source)
    defer { try? reader.close() }
    while true {
      try control.check()
      let chunk = try reader.read(upToCount: 64 * 1024) ?? Data()
      if chunk.isEmpty { break }
      try append(chunk)
    }
    try append(Data("\r\n".utf8))
  }
  try append(Data("--\(entry.boundary)--\r\n".utf8))
  try output.synchronize()
  try control.check()
  try TransferJournal.commit(partial, to: journal.body(entry.snapshot.transferId))
  committed = true
  return length
}
