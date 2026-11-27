// swift-tools-version: 6.0

import PackageDescription

// The Safari extension's token reader: reading the bridge's token files and
// building the reply to the background script. A package of its own so its tests
// run with `swift test`, which builds no app. Xcode registers every app it builds
// with Launch Services, and Safari can then run that copy of the extension
// instead of the installed one.
let package = Package(
    name: "TokenReader",
    platforms: [
        .macOS("14.0"),
    ],
    products: [
        .library(name: "TokenReader", targets: ["TokenReader"]),
    ],
    targets: [
        .target(name: "TokenReader"),
        .testTarget(name: "TokenReaderTests", dependencies: ["TokenReader"]),
    ]
)
