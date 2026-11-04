import Foundation

/// Lets a message that can repeat without bound through once per interval, and
/// counts the ones it held back so the next report can say how many there were.
struct LogThrottle {
    private let interval: Duration
    private var lastReported: ContinuousClock.Instant?
    private var held = 0

    init(interval: Duration) {
        self.interval = interval
    }

    /// Nil while the message is being held back. Otherwise it may be logged, and the
    /// number is how many were held back since the last one that was.
    mutating func admit(at now: ContinuousClock.Instant = .now) -> Int? {
        if let lastReported, now < lastReported + interval {
            held += 1
            return nil
        }
        lastReported = now
        defer { held = 0 }
        return held
    }
}
