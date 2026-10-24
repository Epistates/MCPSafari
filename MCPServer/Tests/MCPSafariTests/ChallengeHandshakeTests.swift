import Foundation
import Testing
@testable import MCPSafari

/// The mutual challenge-response handshake, driven over real loopback sockets by a
/// test client that computes its HMACs independently of the server's code. See
/// `BridgeHandshake` for the exchange.
struct ChallengeHandshakeTests {
    private let token = "B9F4C2A1-7E3D-4F10-9A6B-0C5D8E2F1A34"

    /// A transport that remembers every frame in either direction, so a test can
    /// look at everything that crossed the wire.
    private final class Recording<Inner: FrameTransport>: FrameTransport {
        let inner: Inner
        private(set) var frames: [String] = []
        init(_ inner: Inner) { self.inner = inner }

        func sendFrame(_ text: String) async throws {
            frames.append(text)
            try await inner.sendFrame(text)
        }

        func receiveFrame() async throws -> String {
            let text = try await inner.receiveFrame()
            frames.append(text)
            return text
        }
    }

    // MARK: - Proofs

    /// The same two values are asserted by the extension's tests, which compute
    /// them with WebCrypto. Agreement on fixed inputs is what keeps the two
    /// implementations on one definition of the message.
    @Test func theProofsMatchTheKnownAnswers() {
        let clientNonce = String(repeating: "A", count: 43)
        let serverNonce = String(repeating: "B", count: 43)
        let serverExpected = "Vu6_f6XKAvJZ-jhqHWGJdqiV7Fg2ZfpPoM9koUiT22U"
        let clientExpected = "Pd_tPFSAAAEYm9VKBPq4lTqgdoj3DS1i-FN1nh6B-1E"

        #expect(BridgeHandshake.serverProof(token: token, port: 8089, clientNonce: clientNonce, serverNonce: serverNonce) == serverExpected)
        #expect(BridgeHandshake.clientProof(token: token, port: 8089, clientNonce: clientNonce, serverNonce: serverNonce) == clientExpected)
        #expect(TestExtension.serverProof(token: token, port: 8089, clientNonce: clientNonce, serverNonce: serverNonce) == serverExpected)
        #expect(TestExtension.clientProof(token: token, port: 8089, clientNonce: clientNonce, serverNonce: serverNonce) == clientExpected)
    }

    @Test func aProofIsBoundToItsDirectionItsPortAndItsNonces() {
        let a = BridgeHandshake.makeNonce()
        let b = BridgeHandshake.makeNonce()
        let proof = BridgeHandshake.clientProof(token: token, port: 8089, clientNonce: a, serverNonce: b)

        #expect(BridgeHandshake.isValidClientProof(proof, token: token, port: 8089, clientNonce: a, serverNonce: b))
        #expect(!BridgeHandshake.isValidClientProof(proof, token: "other", port: 8089, clientNonce: a, serverNonce: b))
        #expect(!BridgeHandshake.isValidClientProof(proof, token: token, port: 8090, clientNonce: a, serverNonce: b))
        #expect(!BridgeHandshake.isValidClientProof(proof, token: token, port: 8089, clientNonce: b, serverNonce: a))
        // The server's proof over the same nonces is a different message.
        let reflected = BridgeHandshake.serverProof(token: token, port: 8089, clientNonce: a, serverNonce: b)
        #expect(!BridgeHandshake.isValidClientProof(reflected, token: token, port: 8089, clientNonce: a, serverNonce: b))
    }

    @Test func aProofThatIsNotStrictBase64URLIsInvalid() {
        let a = BridgeHandshake.makeNonce()
        let b = BridgeHandshake.makeNonce()
        let proof = BridgeHandshake.clientProof(token: token, port: 8089, clientNonce: a, serverNonce: b)
        let standard = proof.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")

        for bad in ["", "!!!", proof + "=", proof + "A", String(proof.dropLast(2)), standard == proof ? proof + "+" : standard] {
            #expect(!BridgeHandshake.isValidClientProof(bad, token: token, port: 8089, clientNonce: a, serverNonce: b), "\(bad)")
        }
    }

    // MARK: - A good exchange

    @Test func aValidExchangeAuthenticatesTheProfile() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()

            let extensionSide = TestExtension(
                token: await bridge.authToken,
                port: port,
                profileId: "WORK-UUID"
            )
            // `handshake` throws unless the server's proof checks out, so reaching
            // the reply is already the server having proved itself first.
            let reply = try await extensionSide.handshake(over: task)

            #expect(reply["auth"] as? String == "ok")
            #expect(reply["profile"] as? String == "WORK-UUID")
            #expect(reply["protocolVersion"] as? Int == MCPSafariProduct.bridgeProtocolVersion)
            let status = await bridge.status()
            #expect(status.profiles.map(\.id) == ["WORK-UUID"])
            #expect(status.extensionVersion == "0.4.0")
        }
    }

    @Test func theTokenNeverCrossesTheWire() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()
            let transcript = Recording(task)

            _ = try await TestExtension(token: await bridge.authToken, port: port).handshake(over: transcript)

            let secret = await bridge.authToken
            #expect(transcript.frames.count == 4, "hello, challenge, proof, ok")
            for frame in transcript.frames { #expect(!frame.contains(secret), "\(frame)") }
        }
    }

    @Test func theServersProofIsOneOnlyTheTokenHolderCouldMake() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()

            let secret = await bridge.authToken
            let extensionSide = TestExtension(token: secret, port: port)
            let challengeFrame = try await extensionSide.sayHello(over: task)
            let challenge = try #require(challengeFrame["challenge"] as? [String: Any])
            let serverNonce = try #require(challenge["serverNonce"] as? String)
            let proof = try #require(challenge["serverProof"] as? String)

            // A client holding the right token accepts it...
            #expect(extensionSide.serverIsGenuine(challengeFrame))
            // ...and one holding any other token, another nonce of its own, or
            // dialling another port would not, which is what stops a listener that
            // merely accepted the connection from passing for the server.
            var staleToken = extensionSide
            staleToken.token = "a-token-from-a-previous-run"
            #expect(!staleToken.serverIsGenuine(challengeFrame))
            var otherNonce = extensionSide
            otherNonce.clientNonce = BridgeHandshake.makeNonce()
            #expect(!otherNonce.serverIsGenuine(challengeFrame))
            var otherPort = extensionSide
            otherPort.port = port &+ 1
            #expect(!otherPort.serverIsGenuine(challengeFrame))
            // Nor does the client-direction label at the same nonces.
            let wrongLabel = TestExtension.clientProof(
                token: secret, port: port, clientNonce: extensionSide.clientNonce, serverNonce: serverNonce
            )
            #expect(wrongLabel != proof)
        }
    }

    // MARK: - Bad proofs

    @Test func aProofFromTheWrongKeyIsRejectedAndNeverRegisters() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()

            let extensionSide = TestExtension(token: await bridge.authToken, port: port)
            let reply = try await extensionSide.handshake(over: task, proofToken: "the-wrong-token")

            #expect(reply["error"] as? String == "token_mismatch")
            #expect(await serverHungUp(on: task))
            #expect(await bridge.status().profiles.isEmpty)
        }
    }

    @Test func theServersOwnProofReflectedBackIsRejected() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()

            let extensionSide = TestExtension(token: await bridge.authToken, port: port)
            let challengeFrame = try await extensionSide.sayHello(over: task)
            let challenge = try #require(challengeFrame["challenge"] as? [String: Any])
            // A peer with no token that hands the server's own proof back as its answer.
            let reflected = try #require(challenge["serverProof"] as? String)
            try await task.send(.string(TestExtension.proofFrame(reflected)))

            let reply = try TestExtension.parse(try await task.receiveFrame())
            #expect(reply["error"] as? String == "token_mismatch")
            #expect(await bridge.status().profiles.isEmpty)
        }
    }

    @Test func aProofIsNotUsableOnAnotherConnection() async throws {
        try await withStartedBridge { bridge, port in
            let secret = await bridge.authToken
            // Both connections use the same client nonce, as a replaying peer would.
            let nonce = BridgeHandshake.makeNonce()
            var first = TestExtension(token: secret, port: port)
            first.clientNonce = nonce
            var second = first
            second.profileId = "OTHER"

            let taskA = webSocketTask(port: port)
            let taskB = webSocketTask(port: port)
            defer { taskA.cancel(); taskB.cancel() }
            taskA.resume()
            taskB.resume()

            let challengeA = try #require(try await first.sayHello(over: taskA)["challenge"] as? [String: Any])
            let challengeB = try #require(try await second.sayHello(over: taskB)["challenge"] as? [String: Any])
            let serverNonceA = try #require(challengeA["serverNonce"] as? String)
            let serverNonceB = try #require(challengeB["serverNonce"] as? String)
            // Fresh every time, so a captured exchange has nothing to attach to.
            #expect(serverNonceA != serverNonceB)
            #expect(challengeA["serverProof"] as? String != challengeB["serverProof"] as? String)

            // A finishes properly; its proof, sent on B, is for A's nonce.
            let proofForA = TestExtension.clientProof(token: secret, port: port, clientNonce: nonce, serverNonce: serverNonceA)
            try await taskA.send(.string(TestExtension.proofFrame(proofForA)))
            #expect(try TestExtension.parse(try await taskA.receiveFrame())["auth"] as? String == "ok")

            try await taskB.send(.string(TestExtension.proofFrame(proofForA)))
            let replay = try TestExtension.parse(try await taskB.receiveFrame())
            #expect(replay["error"] as? String == "token_mismatch")
            #expect(await bridge.status().profiles.map(\.id) == ["default"])
        }
    }

    @Test func malformedProofFramesCloseTheConnection() async throws {
        let frames = [
            #"{"auth":{}}"#,
            #"{"auth":{"clientProof":5}}"#,
            #"{"auth":"a-token-in-the-old-place"}"#,
            #"{"clientProof":"x"}"#,
            "not json",
        ]
        for frame in frames {
            try await withStartedBridge { bridge, port in
                let task = webSocketTask(port: port)
                defer { task.cancel() }
                task.resume()
                _ = try await TestExtension(token: await bridge.authToken, port: port).sayHello(over: task)

                try await task.send(.string(frame))

                #expect(await serverHungUp(on: task), "\(frame)")
                #expect(await bridge.status().profiles.isEmpty)
            }
        }
    }

    // MARK: - Out of order

    @Test func aProofBeforeAnyHelloClosesTheConnection() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()

            try await task.send(.string(TestExtension.proofFrame(BridgeHandshake.makeNonce())))

            #expect(await serverHungUp(on: task))
            #expect(await bridge.status().profiles.isEmpty)
        }
    }

    @Test func aSecondHelloBeforeTheProofClosesTheConnection() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()
            let extensionSide = TestExtension(token: await bridge.authToken, port: port)
            _ = try await extensionSide.sayHello(over: task)

            try await task.send(.string(extensionSide.helloFrame()))

            #expect(await serverHungUp(on: task))
            #expect(await bridge.status().profiles.isEmpty)
        }
    }

    @Test func aRequestShapedFrameMidHandshakeClosesTheConnection() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()
            _ = try await TestExtension(token: await bridge.authToken, port: port).sayHello(over: task)

            try await task.send(.string(#"{"id":"x","success":true,"data":"forged"}"#))

            #expect(await serverHungUp(on: task))
            #expect(await bridge.status().profiles.isEmpty)
        }
    }

    @Test func aHelloWithAMalformedNonceClosesTheConnection() async throws {
        for nonce in ["", "short", String(repeating: "A", count: 44), String(repeating: "!", count: 43)] {
            try await withStartedBridge { bridge, port in
                let task = webSocketTask(port: port)
                defer { task.cancel() }
                task.resume()
                var extensionSide = TestExtension(token: await bridge.authToken, port: port)
                extensionSide.clientNonce = nonce

                try await task.send(.string(extensionSide.helloFrame()))

                #expect(await serverHungUp(on: task), "\(nonce)")
            }
        }
    }

    // MARK: - Protocol mismatch

    @Test func aHelloFromAnotherProtocolIsToldSoWithoutBeingRecorded() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()
            var extensionSide = TestExtension(token: await bridge.authToken, port: port)
            // Not a real release, so this cannot read as a shipped version being refused.
            extensionSide.protocolVersion = 99
            extensionSide.extensionVersion = "99.0.0"

            let reply = try await extensionSide.sayHello(over: task)

            #expect(reply["error"] as? String == "protocol_version_mismatch")
            #expect(reply["extensionProtocolVersion"] as? Int == 99)
            #expect(reply["serverProtocolVersion"] as? Int == MCPSafariProduct.bridgeProtocolVersion)
            #expect(await serverHungUp(on: task))

            // Anything on the machine can send this frame without holding the
            // token, and `status` is what the user is told, so it is not kept.
            let status = await bridge.status()
            #expect(status.lastError == nil)
            #expect(status.extensionVersion == nil)
        }
    }

    @Test func anOlderBuildThatSendsTheTokenIsToldToUpdateAndRecorded() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()

            // The frame a 0.3 extension sends, token and all.
            let secret = await bridge.authToken
            try await task.send(.string(#"{"auth":"\#(secret)","extensionVersion":"0.3.2","protocolVersion":1,"profileId":"default"}"#))
            let reply = try TestExtension.parse(try await task.receiveFrame())

            #expect(reply["error"] as? String == "protocol_version_mismatch")
            #expect(reply["extensionProtocolVersion"] as? Int == 1)
            #expect(reply["serverProtocolVersion"] as? Int == MCPSafariProduct.bridgeProtocolVersion)
            // It proved it holds the token, so what it reports is worth showing.
            let status = await bridge.status()
            #expect(status.lastError?.code == "protocol_version_mismatch")
            #expect(status.extensionVersion == "0.3.2")
            #expect(status.extensionProtocolVersion == 1)
            #expect(status.profiles.isEmpty)
        }
    }

    @Test func anOlderBuildWithTheWrongTokenIsJustToldTheTokenIsWrong() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()

            try await task.send(.string(#"{"auth":"not-the-token","extensionVersion":"0.3.2","protocolVersion":1}"#))
            let reply = try TestExtension.parse(try await task.receiveFrame())

            #expect(reply["error"] as? String == "token_mismatch")
            #expect(await bridge.status().lastError == nil)
        }
    }

    // MARK: - Slots and deadline

    /// The cap and the deadline cover the whole exchange, not just the first frame:
    /// a peer that says hello and then stalls is still occupying a slot.
    @Test func aConnectionThatStallsAfterTheChallengeIsDroppedAtTheDeadline() async throws {
        try await withStartedBridge(handshakeDeadline: .milliseconds(300)) { bridge, port in
            let socket = try #require(RawSocket.dial(port: port))
            #expect(socket.reply() == .upgraded)
            try await socket.sendFrame(TestExtension(token: await bridge.authToken, port: port).helloFrame())
            #expect(try await socket.receiveFrame().contains("challenge"))

            // The challenge went unanswered, and the deadline closes it all the same.
            #expect(socket.reply(within: 5) == .closed)
            #expect(await eventually { await bridge.status().bridge == .disconnected })
        }
    }

    @Test func connectionsMidExchangeCountAgainstTheCap() async throws {
        try await withStartedBridge { bridge, port in
            let secret = await bridge.authToken
            var held: [(socket: RawSocket, extensionSide: TestExtension, challenge: [String: Any])] = []
            for _ in 0..<8 {
                let socket = try #require(RawSocket.dial(port: port))
                #expect(socket.reply() == .upgraded)
                let extensionSide = TestExtension(token: secret, port: port)
                let challengeFrame = try await extensionSide.sayHello(over: socket)
                held.append((socket, extensionSide, try #require(challengeFrame["challenge"] as? [String: Any])))
            }

            let ninth = try #require(RawSocket.dial(port: port))
            #expect(ninth.reply() == .closed)

            // And the oldest of the eight can still finish.
            let oldest = held[0]
            let proof = TestExtension.clientProof(
                token: secret,
                port: port,
                clientNonce: oldest.extensionSide.clientNonce,
                serverNonce: try #require(oldest.challenge["serverNonce"] as? String)
            )
            try await oldest.socket.sendFrame(TestExtension.proofFrame(proof))
            #expect(try TestExtension.parse(try await oldest.socket.receiveFrame())["auth"] as? String == "ok")
        }
    }
}
