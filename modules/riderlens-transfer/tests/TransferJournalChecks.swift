import Foundation

// Host Foundation checks. UIKit suspension and native-session lifecycle still
// require the iOS integration/device suite; these checks do not substitute it.
@main
struct TransferJournalChecks {
  static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw NSError(domain: "TransferJournalCheck", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
  }

  static func main() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("transfer-check-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try TransferJournal(rootURL: root)
    let source = root.appendingPathComponent("source.mov")
    // Cross multiple 64 KiB copy boundaries and preserve arbitrary binary bytes.
    let video = Data((0..<(14 * 1024 * 1024)).map { UInt8($0 % 251) })
    try video.write(to: source)
    let input = TransferInput(attemptId: "analysis-test", url: "https://example.invalid/capture/jobs", sourceUri: source.absoluteString,
      fields: ["request_id": "analysis-test", "start_seconds": "0", "end_seconds": "4", "events_json": "[]"],
      headers: ["x-riderlens-key": "fixture"])
    let id = UUID().uuidString
    var entry = TransferEntry(snapshot: TransferSnapshot(attemptId: input.attemptId, transferId: id, state: "preparing", createdAt: 1000),
      input: input, fingerprint: try input.validatedFingerprint(), boundary: "fixture-boundary", taskIdentifier: nil)
    try store.save(entry)
    let length = try prepareMultipart(entry, journal: store, control: PreparationControl())
    let body = try Data(contentsOf: store.body(id))
    try require(length == body.count, "Multipart byte count does not match the file.")
    try require(body.range(of: video) != nil, "Multipart did not preserve the video bytes.")
    try require(body.range(of: Data("name=\"video\"; filename=\"clip.mov\"\r\nContent-Type: video/quicktime".utf8)) != nil, "MOV field/MIME changed.")
    try require(body.suffix(22) == Data("--fixture-boundary--\r\n".utf8).suffix(22), "Missing closing boundary.")
    try require(!FileManager.default.fileExists(atPath: store.partial(id).path), "Partial file survives successful rename.")
    let otherId = UUID().uuidString
    let other = TransferEntry(snapshot: TransferSnapshot(attemptId: input.attemptId, transferId: otherId, state: "preparing", createdAt: 2000),
      input: input, fingerprint: entry.fingerprint, boundary: "another-boundary", taskIdentifier: nil)
    try store.save(other)
    _ = try prepareMultipart(other, journal: store, control: PreparationControl())
    try require(store.body(id) != store.body(otherId), "Transfer bodies reuse a filename.")
    let unchanged = try Data(contentsOf: store.body(id))
    try require(unchanged == body, "Another transfer overwrote the first multipart file.")
    let loaded = try store.load()
    try require(loaded[id]?.fingerprint == entry.fingerprint, "Durable intent was not restored.")
    entry.snapshot.state = "terminal"
    entry.snapshot.status = 202
    entry.snapshot.body = "{\"jobId\":\"analysis-test\",\"status\":\"queued\"}"
    try store.save(entry)
    try store.removeBody(id)
    let restored = try store.load()
    try require(restored[id]?.snapshot.body == entry.snapshot.body, "Receipt did not survive multipart cleanup.")
    let stop = PreparationControl()
    stop.stop()
    do { _ = try prepareMultipart(entry, journal: store, control: stop); throw transferError("CHECK_FAILED", "Stopped preparation succeeded.") }
    catch { try require((error as NSError).domain == "E_PREPARATION_PAUSED", "Stopped preparation did not return its checkpoint error.") }
    try require(!FileManager.default.fileExists(atPath: store.partial(id).path), "Cancelled preparation leaked its partial file.")
    try require(FileManager.default.fileExists(atPath: source.path), "Preparation removed the original source.")
    try Data("broken".utf8).write(to: store.directory(id).appendingPathComponent("journal.json"))
    do { _ = try store.load(); throw transferError("CHECK_FAILED", "Corrupt journal did not fail closed.") }
    catch { try require((error as NSError).domain != "CHECK_FAILED", "Corrupt journal was silently ignored.") }
    let badRoot = root.appendingPathComponent("not-a-directory")
    try Data("file".utf8).write(to: badRoot)
    do { _ = try TransferJournal(rootURL: badRoot); throw transferError("CHECK_FAILED", "Invalid storage path succeeded.") }
    catch { try require((error as NSError).domain != "CHECK_FAILED", "Invalid storage path was silently accepted.") }
    print("TransferJournal checks passed: 14 MiB multipart, MIME/fields, unique files, intent/receipt persistence, stop cleanup, corruption, invalid storage path.")
  }
}
