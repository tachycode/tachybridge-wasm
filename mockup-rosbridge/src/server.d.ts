export type MockupRosbridgeServer = {
    port: number;
    url: string;
    stop: () => Promise<void>;
};
export declare function createMockupRosbridgeServer(port?: number): Promise<MockupRosbridgeServer>;
