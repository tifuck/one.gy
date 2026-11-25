package cloudfiles

import "unsafe"

// cfapi.h structures, laid out as the C compiler does on 64-bit Windows
// (sizes are checked in cloudfiles_test.go: 72, 24, 12 and 1028 bytes).

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

// cfSyncRegistration is CF_SYNC_REGISTRATION.
type cfSyncRegistration struct {
	StructSize             uint32
	ProviderName           *uint16
	ProviderVersion        *uint16
	SyncRootIdentity       unsafe.Pointer
	SyncRootIdentityLength uint32
	FileIdentity           unsafe.Pointer
	FileIdentityLength     uint32
	ProviderID             guid
}

// cfPolicy is CF_HYDRATION_POLICY / CF_POPULATION_POLICY (two USHORTs).
type cfPolicy struct{ Primary, Modifier uint16 }

// cfSyncPolicies is CF_SYNC_POLICIES. Platforms before integration number
// 0x310 know it without PlaceholderManagement (StructSize 20).
type cfSyncPolicies struct {
	StructSize            uint32
	Hydration             cfPolicy
	Population            cfPolicy
	InSync                uint32
	HardLink              uint32
	PlaceholderManagement uint32
}

// cfPlatformInfo is CF_PLATFORM_INFO.
type cfPlatformInfo struct {
	BuildNumber, RevisionNumber, IntegrationNumber uint32
}

// cfSyncRootProviderInfo is CF_SYNC_ROOT_PROVIDER_INFO.
type cfSyncRootProviderInfo struct {
	ProviderStatus  uint32
	ProviderName    [256]uint16
	ProviderVersion [256]uint16
}

const (
	cfHydrationAlwaysFull  = 3 // CF_HYDRATION_POLICY_ALWAYS_FULL
	cfPopulationAlwaysFull = 3 // CF_POPULATION_POLICY_ALWAYS_FULL

	cfRegisterUpdate       = 0x1 // CF_REGISTER_FLAG_UPDATE
	cfRegisterMarkRootSync = 0x4 // CF_REGISTER_FLAG_MARK_IN_SYNC_ON_ROOT

	cfConvertMarkInSync = 0x1 // CF_CONVERT_FLAG_MARK_IN_SYNC
	cfConvertAlwaysFull = 0x8 // CF_CONVERT_FLAG_ALWAYS_FULL

	cfSyncRootInfoProvider = 2 // CF_SYNC_ROOT_INFO_PROVIDER
)

// providerID is ONE.GY's Cloud Files provider GUID
// {6f1c3b0e-5a7d-4e2b-9c41-0e9b3d2a7f61}, the same in every version.
var providerID = guid{0x6f1c3b0e, 0x5a7d, 0x4e2b, [8]byte{0x9c, 0x41, 0x0e, 0x9b, 0x3d, 0x2a, 0x7f, 0x61}}
